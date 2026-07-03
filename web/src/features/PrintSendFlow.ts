import { sendToPrinter, PrinterConfig } from '../net/PrinterClient';

export interface PrintOptions {
  timelapse: boolean;
  bedLeveling: boolean;
  calibrateExtruder: boolean;
}

export class PrintSendFlow {
  async sendJob(cfg: PrinterConfig, gcode: string, opts: PrintOptions): Promise<boolean> {
    let modifiedGcode = gcode;
    if (opts.bedLeveling) modifiedGcode = 'G29\n' + modifiedGcode; 
    if (opts.timelapse) modifiedGcode = 'TIMELAPSE_TAKE_FRAME\n' + modifiedGcode;
    
    const res = await sendToPrinter(cfg, modifiedGcode, 'job.gcode', true);
    return res.ok;
  }
}
