import { WebSocketServer as WSServer, WebSocket } from 'ws';
import { Server } from 'http';
import { EventEmitter } from 'events';
import { Logger } from '@utils/logger';
import { ServerConfig } from '@utils/types';
import ConfigManager from '../core/config-manager';
import SessionManager from '../core/session-manager';

interface WebSocketClient {
  id: string;
  ws: WebSocket;
  subscriptions: Set<string>;
  lastPing: number;
  metadata: {
    connectedAt: Date;
    userAgent?: string;
    ip?: string;
  };
}

export class WebSocketServer extends EventEmitter {
  private wss: WSServer | null = null;
  private server: Server | null = null;
  private config: ServerConfig;
  private sessionManager: SessionManager;
  private clients: Map<string, WebSocketClient> = new Map();
  private isStarted = false;
  private pingInterval: NodeJS.Timeout | null = null;
  private metricsInterval: NodeJS.Timeout | null = null;

  constructor(sessionManager: SessionManager) {
    super();
    this.config = ConfigManager.getInstance().get<ServerConfig>('server');
    this.sessionManager = sessionManager;

    this.setupEventHandlers();
  }

  public async start(): Promise<void> {
    if (this.isStarted) {
      Logger.warn('WebSocket server already started');
      return;
    }

    Logger.info('Starting WebSocket Server');

    return new Promise((resolve, reject) => {
      try {
        this.wss = new WSServer({
          port: this.config.websocket.port,
          perMessageDeflate: true,
          maxPayload: 10 * 1024 * 1024, // 10MB
        });

        this.wss.on('listening', () => {
          this.isStarted = true;
          this.startPeriodicTasks();
          this.emit('started');
          Logger.info(`WebSocket Server started on port ${this.config.websocket.port}`);
          resolve();
        });

        this.wss.on('error', (error) => {
          Logger.error('WebSocket Server error', error);
          reject(error);
        });

        this.wss.on('connection', (ws, request) => {
          this.handleNewConnection(ws, request);
        });

      } catch (error) {
        Logger.error('Failed to start WebSocket server', error);
        reject(error);
      }
    });
  }

  public async shutdown(): Promise<void> {
    if (!this.isStarted || !this.wss) {
      return;
    }

    Logger.info('Shutting down WebSocket Server');

    // Stop periodic tasks
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
    }
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
    }

    // Close all client connections
    for (const client of this.clients.values()) {
      client.ws.close(1000, 'Server shutting down');
    }

    return new Promise((resolve) => {
      this.wss!.close(() => {
        this.isStarted = false;
        this.emit('shutdown');
        Logger.info('WebSocket Server shutdown complete');
        resolve();
      });
    });
  }

  public broadcast(event: string, data: any, filter?: (client: WebSocketClient) => boolean): void {
    const message = JSON.stringify({
      type: 'event',
      event,
      data,
      timestamp: new Date().toISOString()
    });

    let sentCount = 0;
    for (const client of this.clients.values()) {
      if (filter && !filter(client)) {
        continue;
      }

      if (client.ws.readyState === WebSocket.OPEN) {
        try {
          client.ws.send(message);
          sentCount++;
        } catch (error) {
          Logger.error(`Failed to send message to client ${client.id}`, error);
        }
      }
    }

    Logger.debug(`Broadcasted event to ${sentCount} clients`, { event, clients: sentCount });
  }

  public sendToClient(clientId: string, event: string, data: any): boolean {
    const client = this.clients.get(clientId);
    if (!client || client.ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    const message = JSON.stringify({
      type: 'event',
      event,
      data,
      timestamp: new Date().toISOString()
    });

    try {
      client.ws.send(message);
      return true;
    } catch (error) {
      Logger.error(`Failed to send message to client ${clientId}`, error);
      return false;
    }
  }

  public getHealth(): any {
    return {
      status: this.isStarted ? 'running' : 'stopped',
      port: this.config.websocket.port,
      clients: {
        total: this.clients.size,
        connected: Array.from(this.clients.values()).filter(c => c.ws.readyState === WebSocket.OPEN).length
      },
      uptime: this.isStarted ? Date.now() - (this.wss as any).startTime : 0
    };
  }

  private handleNewConnection(ws: WebSocket, request: any): void {
    const clientId = this.generateClientId();
    const client: WebSocketClient = {
      id: clientId,
      ws,
      subscriptions: new Set(),
      lastPing: Date.now(),
      metadata: {
        connectedAt: new Date(),
        userAgent: request.headers['user-agent'],
        ip: request.socket.remoteAddress
      }
    };

    this.clients.set(clientId, client);

    Logger.info(`WebSocket client connected: ${clientId}`, {
      totalClients: this.clients.size,
      userAgent: client.metadata.userAgent,
      ip: client.metadata.ip
    });

    // Send welcome message
    this.sendWelcomeMessage(client);

    // Setup client event handlers
    this.setupClientHandlers(client);

    this.emit('clientConnected', client);
  }

  private setupClientHandlers(client: WebSocketClient): void {
    const { ws } = client;

    // Message handler
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        this.handleClientMessage(client, message);
      } catch (error) {
        Logger.error(`Invalid message from client ${client.id}`, error);
        this.sendError(client, 'INVALID_MESSAGE', 'Invalid JSON message format');
      }
    });

    // Pong handler
    ws.on('pong', () => {
      client.lastPing = Date.now();
    });

    // Close handler
    ws.on('close', (code, reason) => {
      this.handleClientDisconnect(client, code, reason?.toString());
    });

    // Error handler
    ws.on('error', (error) => {
      Logger.error(`WebSocket client error: ${client.id}`, error);
      this.handleClientDisconnect(client, 1006, 'Connection error');
    });
  }

  private handleClientMessage(client: WebSocketClient, message: any): void {
    const { type, event, data } = message;

    switch (type) {
      case 'subscribe':
        this.handleSubscribe(client, event);
        break;

      case 'unsubscribe':
        this.handleUnsubscribe(client, event);
        break;

      case 'ping':
        this.sendPong(client);
        break;

      case 'session_logs':
        this.handleSessionLogs(client, data);
        break;

      case 'metrics_request':
        this.handleMetricsRequest(client);
        break;

      default:
        Logger.warn(`Unknown message type from client ${client.id}`, { type, event });
        this.sendError(client, 'UNKNOWN_MESSAGE_TYPE', `Unknown message type: ${type}`);
    }
  }

  private handleSubscribe(client: WebSocketClient, event: string): void {
    if (!event) {
      return this.sendError(client, 'MISSING_EVENT', 'Event name is required for subscription');
    }

    client.subscriptions.add(event);
    this.sendSuccess(client, 'SUBSCRIBED', { event, subscriptions: Array.from(client.subscriptions) });

    Logger.debug(`Client ${client.id} subscribed to ${event}`, {
      totalSubscriptions: client.subscriptions.size
    });
  }

  private handleUnsubscribe(client: WebSocketClient, event: string): void {
    if (!event) {
      return this.sendError(client, 'MISSING_EVENT', 'Event name is required for unsubscription');
    }

    client.subscriptions.delete(event);
    this.sendSuccess(client, 'UNSUBSCRIBED', { event, subscriptions: Array.from(client.subscriptions) });

    Logger.debug(`Client ${client.id} unsubscribed from ${event}`, {
      totalSubscriptions: client.subscriptions.size
    });
  }

  private handleSessionLogs(client: WebSocketClient, data: any): void {
    const { sessionId, since } = data;

    if (!sessionId) {
      return this.sendError(client, 'MISSING_SESSION_ID', 'Session ID is required for log streaming');
    }

    // Subscribe client to session logs
    client.subscriptions.add(`session:${sessionId}:logs`);

    // Send recent logs if available
    this.sendSessionLogs(client, sessionId, since);

    Logger.debug(`Client ${client.id} subscribed to session logs: ${sessionId}`);
  }

  private handleMetricsRequest(client: WebSocketClient): void {
    const metrics = {
      system: {
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        timestamp: new Date().toISOString()
      },
      sessions: this.sessionManager.getSessionsHealth(),
      websocket: this.getHealth()
    };

    this.sendToClient(client.id, 'metrics_update', metrics);
  }

  private sendWelcomeMessage(client: WebSocketClient): void {
    const welcome = {
      type: 'welcome',
      clientId: client.id,
      serverVersion: '2.0.0',
      timestamp: new Date().toISOString(),
      availableEvents: [
        'session_created',
        'session_destroyed',
        'session_navigation',
        'browser_instance_created',
        'browser_instance_destroyed',
        'plugin_enabled',
        'plugin_disabled',
        'system_metrics'
      ]
    };

    client.ws.send(JSON.stringify(welcome));
  }

  private sendSuccess(client: WebSocketClient, code: string, data?: any): void {
    const message = {
      type: 'response',
      success: true,
      code,
      data,
      timestamp: new Date().toISOString()
    };

    client.ws.send(JSON.stringify(message));
  }

  private sendError(client: WebSocketClient, code: string, message: string, details?: any): void {
    const errorMessage = {
      type: 'response',
      success: false,
      error: {
        code,
        message,
        details
      },
      timestamp: new Date().toISOString()
    };

    client.ws.send(JSON.stringify(errorMessage));
  }

  private sendPong(client: WebSocketClient): void {
    const pong = {
      type: 'pong',
      timestamp: new Date().toISOString()
    };

    client.ws.send(JSON.stringify(pong));
  }

  private sendSessionLogs(client: WebSocketClient, sessionId: string, since?: string): void {
    // This would typically fetch logs from a log store
    // For now, just send a placeholder
    const logs = {
      sessionId,
      logs: [
        {
          timestamp: new Date().toISOString(),
          level: 'info',
          message: 'Session logs streaming started',
          sessionId
        }
      ],
      hasMore: false
    };

    this.sendToClient(client.id, 'session_logs', logs);
  }

  private handleClientDisconnect(client: WebSocketClient, code: number, reason?: string): void {
    this.clients.delete(client.id);

    Logger.info(`WebSocket client disconnected: ${client.id}`, {
      code,
      reason,
      totalClients: this.clients.size,
      connectionDuration: Date.now() - client.metadata.connectedAt.getTime()
    });

    this.emit('clientDisconnected', client, code, reason);
  }

  private setupEventHandlers(): void {
    // Listen to session manager events
    this.sessionManager.on('sessionCreated', (session) => {
      this.broadcast('session_created', {
        sessionId: session.id,
        metadata: session.metadata
      }, (client) => client.subscriptions.has('session_created'));
    });

    this.sessionManager.on('sessionDestroyed', (session) => {
      this.broadcast('session_destroyed', {
        sessionId: session.id,
        metadata: session.metadata
      }, (client) => client.subscriptions.has('session_destroyed'));
    });

    this.sessionManager.on('metricsUpdated', (metrics) => {
      this.broadcast('system_metrics', metrics, (client) => client.subscriptions.has('system_metrics'));
    });
  }

  private startPeriodicTasks(): void {
    // Ping clients every 30 seconds to check connection health
    this.pingInterval = setInterval(() => {
      this.pingClients();
    }, 30000);

    // Send metrics updates every 10 seconds
    this.metricsInterval = setInterval(() => {
      this.sendPeriodicMetrics();
    }, 10000);
  }

  private pingClients(): void {
    const now = Date.now();
    const clientsToRemove: string[] = [];

    for (const [clientId, client] of this.clients) {
      const timeSinceLastPing = now - client.lastPing;

      if (timeSinceLastPing > 60000) { // 1 minute timeout
        Logger.warn(`Client ${clientId} ping timeout, closing connection`);
        client.ws.close(1000, 'Ping timeout');
        clientsToRemove.push(clientId);
      } else if (client.ws.readyState === WebSocket.OPEN) {
        try {
          client.ws.ping();
        } catch (error) {
          Logger.error(`Failed to ping client ${clientId}`, error);
        }
      }
    }

    // Remove timed out clients
    for (const clientId of clientsToRemove) {
      this.clients.delete(clientId);
    }
  }

  private sendPeriodicMetrics(): void {
    const metricsSubscribers = Array.from(this.clients.values())
      .filter(client => client.subscriptions.has('system_metrics'));

    if (metricsSubscribers.length === 0) {
      return;
    }

    const metrics = {
      timestamp: new Date().toISOString(),
      sessions: this.sessionManager.getSessionsHealth(),
      websocket: {
        clients: this.clients.size,
        subscriptions: this.getTotalSubscriptions()
      }
    };

    for (const client of metricsSubscribers) {
      this.sendToClient(client.id, 'system_metrics', metrics);
    }
  }

  private getTotalSubscriptions(): number {
    let total = 0;
    for (const client of this.clients.values()) {
      total += client.subscriptions.size;
    }
    return total;
  }

  private generateClientId(): string {
    return `ws_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}

export default WebSocketServer;