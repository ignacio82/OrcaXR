export interface CatalogModel {
  id: string;
  name: string;
  url: string;
}

export class HandyModelCatalog {
  async fetchModels(): Promise<CatalogModel[]> {
    return [
      { id: '1', name: 'Benchy', url: 'https://example.com/benchy.stl' },
      { id: '2', name: 'Calibration Cube', url: 'https://example.com/cube.stl' },
    ];
  }
}
