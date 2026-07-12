import {normalizeHttpEndpoint} from '../net/LocalNetworkAccess';

export class WebcamSession {
  private host: string = '';
  
  connect(host: string, port: number = 80) {
    const endpoint = normalizeHttpEndpoint(host);
    if (!endpoint) {
      this.host = '';
      return;
    }
    const url = new URL(endpoint);
    if (!url.port && port !== 80) url.port = String(port);
    this.host = url.toString().replace(/\/$/, '');
  }
  
  getStreamUrl(): string {
    if (!this.host) return '';
    return `${normalizeHttpEndpoint(this.host)}/webcam/?action=stream`;
  }
}
