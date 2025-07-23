import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import * as url from 'url';
import * as wrtc from '@koush/wrtc';
import { Logger } from '@nestjs/common';
// import { StreamServiceV1 } from './webrtc.service';
import path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import * as chokidar from 'chokidar';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import * as mime from 'mime-types';
import { StreamServiceV1 } from './webrtc.service';

@WebSocketGateway(3334, { path: '/signaling' })
export class WebrtcGateway implements OnGatewayConnection {
  @WebSocketServer()
  server: Server;
  private logger = new Logger(WebrtcGateway.name);
  private clients: Map<string, WebSocket> = new Map();
  private peerConnections: Map<string, wrtc.RTCPeerConnection> = new Map();
  private sessions = new Map<string, { ffmpeg: any; ws: WebSocket }>();
  private s3 = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  });
  constructor(private readonly streamService: StreamServiceV1) {}

  async handleConnection(client: WebSocket, req: any) {
    const parsed = url.parse(req.url, true);
    const streamId = parsed.query?.streamId as string;
    if (!streamId) {
      client.close(1000, 'Missing streamId');
      return;
    }

    console.log(`Client connected: ${streamId}`);
    const outputDir = path.join(process.cwd(), 'streams', streamId);
    fs.mkdirSync(outputDir, { recursive: true });
    const s3Prefix = `live-streams/${streamId}`;
    // inside handleConnection
    this.streamService.startFFmpeg(streamId, [
      { width: 640, height: 360, bitrate: '800k' },
      { width: 1280, height: 720, bitrate: '2500k' },
    ]);

    client.on('message', (msg) => {
      this.streamService.writeToFFmpeg(streamId, msg);
    });

    client.on('close', () => {
      this.logger.log(`Client disconnected: ${streamId}`);
      this.streamService.stopStream(streamId);
    });
  }

  private async handleMessage(streamId: string, message: any) {
    if (message.type === 'offer') {
      await this.handleOffer(streamId, message);
    } else if (message.type === 'ice-candidate') {
      this.handleIceCandidate(streamId, message);
    }
  }

  private async handleOffer(streamId: string, offer: any) {
    const pc = new wrtc.RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });

    this.peerConnections.set(streamId, pc);

    pc.ontrack = (event) => {
      this.logger.log(`Received ${event.track.kind} track`);
      this.streamService.startFFmpeg(streamId);
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendToClient(streamId, {
          type: 'ice-candidate',
          candidate: event.candidate,
        });
      }
    };

    await pc.setRemoteDescription(offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    this.sendToClient(streamId, {
      type: 'answer',
      sdp: answer.sdp,
    });
  }

  private handleIceCandidate(streamId: string, message: any) {
    const pc = this.peerConnections.get(streamId);
    if (pc) {
      pc.addIceCandidate(new wrtc.RTCIceCandidate(message.candidate));
    }
  }

  private sendToClient(streamId: string, message: any) {
    const client = this.clients.get(streamId);
    if (client && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  }
}
