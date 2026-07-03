export interface PlateMetadata {
  id: number;
  label: string;
  createdAt: number;
}

export class PlateStore {
  private plates: PlateMetadata[] = [{ id: 1, label: 'Plate 1', createdAt: Date.now() }];
  
  public getPlates(): PlateMetadata[] {
    return [...this.plates];
  }
  
  public upsert(plate: PlateMetadata) {
    this.plates = this.plates.filter(p => p.id !== plate.id);
    this.plates.push(plate);
    this.plates.sort((a, b) => a.id - b.id);
  }
  
  public delete(id: number) {
    if (id === 1) return;
    this.plates = this.plates.filter(p => p.id !== id);
  }
}
