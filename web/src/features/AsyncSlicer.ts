export class AsyncSlicer {
  sliceAsync(models: any[], onProgress: (p: number) => void): Promise<string> {
    return new Promise((resolve) => {
      let progress = 0;
      const interval = setInterval(() => {
        progress += 10;
        onProgress(progress);
        if (progress >= 100) {
          clearInterval(interval);
          resolve("; sliced gcode");
        }
      }, 500);
    });
  }
}
