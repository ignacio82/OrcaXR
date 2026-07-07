export class WebcamSession {
  private host: string = '';
  
  connect(host: string, port: number = 80) {
    this.host = host;
  }
  
  getStreamUrl(): string {
    if (!this.host) return '';
    return `http://${this.host}/webcam/?action=stream`;
  }
}
