export class SettingsBackup {
  backup(): string {
    const data = {
      printer: localStorage.getItem('orcaxr.printer'),
      profiles: localStorage.getItem('orcaxr.profiles')
    };
    return JSON.stringify(data);
  }
  
  restore(json: string) {
    const data = JSON.parse(json);
    if (data.printer) localStorage.setItem('orcaxr.printer', data.printer);
    if (data.profiles) localStorage.setItem('orcaxr.profiles', data.profiles);
  }
}
