export interface CustomGcodeEntry {
  layer: number;
  gcode: string;
}

export class CustomGcodeStore {
  private entries: CustomGcodeEntry[] = [];
  
  addEntry(layer: number, gcode: string) {
    this.entries.push({ layer, gcode });
  }
  
  getEntries(): CustomGcodeEntry[] {
    return this.entries;
  }
  
  applyToGcode(gcode: string): string {
    return gcode; 
  }
}
