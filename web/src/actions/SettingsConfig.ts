export interface SettingRow {
  label: string;
  type: 'n' | 'e' | 'b' | 't';
  defaultValue: string;
  unit: string;
  key: string; // We'll infer a key for bindings
}

export interface SettingSection {
  title: string;
  rows: SettingRow[];
}

export interface SettingGroup {
  id: string;
  label: string;
  sections: SettingSection[];
}

export interface SettingSchema {
  process: SettingGroup[];
  filament: SettingGroup[];
  printer: SettingGroup[];
}

const S = (title: string, rows: [string, 'n'|'e'|'b'|'t', string, string][]): SettingSection => ({
  title,
  rows: rows.map(r => ({
    label: r[0],
    type: r[1],
    defaultValue: r[2],
    unit: r[3],
    key: r[0].toLowerCase().replace(/[^a-z0-9]+/g, '_'),
  })),
});

export const SettingsConfig: SettingSchema = {
  process: [
    { id:'quality', label:'Quality', sections:[
      S('Layer height', [['Layer height','n','0.2','mm'],['First layer height','n','0.25','mm']]),
      S('Line width', [['Default','n','0.42','mm'],['First layer','n','0.5','mm'],['Outer wall','n','0.42','mm'],['Inner wall','n','0.45','mm'],['Top surface','n','0.42','mm'],['Sparse infill','n','0.45','mm'],['Internal solid infill','n','0.42','mm'],['Support','n','0.42','mm']]),
      S('Seam', [['Seam position','e','Aligned',''],['Staggered inner seams','b','Off',''],['Seam gap','n','15','%'],['Scarf joint seam','e','Contour',''],['Role based seam','b','On','']]),
      S('Precision', [['Slice gap closing radius','n','0.049','mm'],['Resolution','n','0.012','mm'],['Arc fitting','b','On',''],['X-Y hole compensation','n','0','mm'],['X-Y contour compensation','n','0','mm'],['Elephant foot compensation','n','0.15','mm'],['Precise wall','b','On',''],['Precise Z height','b','Off','']]),
      S('Ironing', [['Ironing type','e','No ironing',''],['Ironing pattern','e','Concentric',''],['Ironing flow','n','10','%'],['Ironing line spacing','n','0.1','mm'],['Ironing speed','n','30','mm/s'],['Ironing inset','n','0','mm']]),
      S('Wall generator', [['Wall generator','e','Classic',''],['Wall transition length','n','100','%'],['Transition threshold angle','n','10','°'],['Transition filter margin','n','25','%'],['Wall distribution count','n','1',''],['Minimum wall width','n','85','%'],['Minimum feature size','n','25','%']]),
      S('Advanced', [['Walls printing order','e','Inner/Outer',''],['Print flush walls first','b','Off',''],['Bridge counterbore holes','e','None',''],['Reduce crossing wall','b','Off',''],['Max travel detour','n','0','%']]),
    ]},
    { id:'strength', label:'Strength', sections:[
      S('Walls', [['Wall loops','n','3',''],['Detect thin wall','b','Off',''],['Detect overhang wall','b','On',''],['Alternate extra wall','b','Off','']]),
      S('Top / bottom shells', [['Top surface pattern','e','Monotonic',''],['Top shell layers','n','4',''],['Top shell thickness','n','0.8','mm'],['Bottom surface pattern','e','Monotonic',''],['Bottom shell layers','n','3',''],['Bottom shell thickness','n','0','mm'],['Internal solid infill','e','Rectilinear','']]),
      S('Infill', [['Sparse infill density','n','15','%'],['Sparse infill pattern','e','Grid',''],['Infill/wall overlap','n','15','%'],['Infill anchor','n','400','%'],['Infill anchor max','n','2','mm'],['Apply gap fill','e','Everywhere',''],['Sparse infill direction','n','45','°'],['Bridge angle','n','0','°'],['Min sparse infill threshold','n','0','mm²']]),
    ]},
    { id:'speed', label:'Speed', sections:[
      S('Initial layer speed', [['Initial layer','n','50','mm/s'],['Initial layer infill','n','105','mm/s']]),
      S('Other layers speed', [['Outer wall','n','200','mm/s'],['Inner wall','n','300','mm/s'],['Small perimeters','n','50','mm/s'],['Small perimeter threshold','n','0','mm'],['Sparse infill','n','270','mm/s'],['Internal solid infill','n','250','mm/s'],['Top surface','n','200','mm/s'],['Gap infill','n','280','mm/s'],['Support','n','150','mm/s'],['Support interface','n','80','mm/s']]),
      S('Overhang speed', [['Slow down for overhangs','b','On',''],['Overhang 1 (0-25%)','n','200','mm/s'],['Overhang 2 (25-50%)','n','50','mm/s'],['Overhang 3 (50-75%)','n','30','mm/s'],['Overhang 4 (75-100%)','n','10','mm/s'],['Bridge','n','50','mm/s'],['Internal bridge','n','80','mm/s']]),
      S('Travel speed', [['Travel','n','500','mm/s']]),
      S('Acceleration', [['Normal printing','n','10000','mm/s²'],['Outer wall','n','5000','mm/s²'],['Inner wall','n','0','mm/s²'],['Bridge','n','5000','mm/s²'],['Sparse infill','n','0','mm/s²'],['Initial layer','n','500','mm/s²'],['Top surface','n','2000','mm/s²'],['Travel','n','10000','mm/s²']]),
      S('Jerk (XY)', [['Default','n','9','mm/s'],['Outer wall','n','9','mm/s'],['Inner wall','n','9','mm/s'],['Infill','n','9','mm/s'],['Top surface','n','9','mm/s'],['Initial layer','n','9','mm/s'],['Travel','n','12','mm/s']]),
    ]},
    { id:'support', label:'Support', sections:[
      S('Support', [['Enable support','b','Off',''],['Type','e','Normal (auto)',''],['Style','e','Grid',''],['Threshold angle','n','30','°'],['On build plate only','b','Off',''],['Top Z distance','n','0.2','mm'],['Bottom Z distance','n','0.2','mm'],['Support/object XY distance','n','0.35','mm'],['Base pattern','e','Rectilinear',''],['Base pattern spacing','n','2.5','mm'],['Interface layers','n','2',''],['Interface spacing','n','0.2','mm'],['Remove small overhangs','b','On','']]),
      S('Raft', [['Raft layers','n','0',''],['Raft contact Z distance','n','0.1','mm'],['Raft expansion','n','1.5','mm'],['First layer density','n','90','%'],['First layer expansion','n','2','mm']]),
      S('Tree support', [['Tree support wall loops','n','1',''],['Branch angle','n','40','°'],['Branch distance','n','5','mm'],['Branch diameter','n','5','mm'],['Tip diameter','n','0.8','mm'],['Branch density','n','5','%']]),
      S('Ooze prevention', [['Enable','b','Off',''],['Temperature variation','n','-5','°C']]),
    ]},
    { id:'others', label:'Others', sections:[
      S('Skirt', [['Skirt loops','n','0',''],['Skirt height','n','1','layers'],['Skirt distance','n','2','mm'],['Skirt speed','n','50','mm/s'],['Draft shield','e','Disabled','']]),
      S('Brim', [['Brim type','e','Auto',''],['Brim width','n','5','mm'],['Brim-object gap','n','0','mm'],['Brim ears','b','Off','']]),
      S('Prime tower', [['Enable','b','Off',''],['Width','n','35','mm'],['Brim width','n','3','mm'],['Wipe tower rotation','n','0','°']]),
      S('Special mode', [['Slicing mode','e','Regular',''],['Print sequence','e','By layer',''],['Spiral vase','b','Off',''],['Timelapse','e','Traditional',''],['Fuzzy skin','e','None','']]),
      S('G-code output', [['Reduce infill retraction','b','On',''],['Add checksum','b','Off',''],['Label objects','b','Off',''],['Exclude objects','b','On',''],['Verbose G-code','b','Off','']]),
      S('Notes', [['Notes','t','—','']]),
    ]},
  ],
  filament: [
    { id:'filament', label:'Filament', sections:[
      S('Basic information', [['Filament type','e','PLA',''],['Vendor','e','Generic',''],['Color','e','#FF6D00',''],['Diameter','n','1.75','mm'],['Flow ratio','n','0.98',''],['Density','n','1.24','g/cm³'],['Cost','n','20','$/kg'],['Spool weight','n','250','g']]),
      S('Temperature', [['Nozzle (initial layer)','n','220','°C'],['Nozzle (other layers)','n','220','°C'],['Smooth PEI plate','n','60','°C'],['Textured PEI plate','n','60','°C'],['Cool plate','n','35','°C'],['Engineering plate','n','0','°C'],['Chamber','n','0','°C']]),
    ]},
    { id:'cooling', label:'Cooling', sections:[
      S('Cooling', [['Enable fan','b','On',''],['Min fan speed','n','100','%'],['Max fan speed','n','100','%'],['Min layer time','n','8','s'],['Slow down if layer time <','n','4','s'],['Slow down min speed','n','20','mm/s'],['Fan on layer','n','2',''],['Overhang fan threshold','e','25%',''],['Overhang fan speed','n','100','%']]),
    ]},
    { id:'overrides', label:'Overrides', sections:[
      S('Retraction overrides', [['Retraction length','n','0.8','mm'],['Z hop','n','0.4','mm'],['Z hop type','e','Normal',''],['Retraction speed','n','30','mm/s'],['Deretraction speed','n','30','mm/s'],['Wipe while retracting','b','On',''],['Wipe distance','n','1','mm'],['Retract on layer change','b','On','']]),
    ]},
    { id:'advanced', label:'Advanced', sections:[
      S('Advanced', [['Pressure advance','b','Off',''],['Pressure advance value','n','0.02',''],['Filament start G-code','t','—',''],['Filament end G-code','t','—','']]),
    ]},
    { id:'multi', label:'Multimaterial', sections:[
      S('Multimaterial', [['Flush volume','n','140','mm³'],['Filament change temp','n','0','°C'],['Filament load time','n','0','s'],['Filament unload time','n','0','s']]),
    ]},
  ],
  printer: [
    { id:'machine', label:'Machine', sections:[
      S('Basic information', [['Printer model','e','Snapmaker Artisan',''],['Nozzle diameter','n','0.4','mm'],['Bed type','e','Textured PEI',''],['Max print height','n','400','mm'],['Printable width','n','350','mm'],['Printable depth','n','350','mm'],['Z offset','n','0','mm']]),
      S('Extruder', [['Nozzle volume','n','92','mm³'],['Extruder clearance radius','n','45','mm'],['Height to rod','n','36','mm'],['Height to lid','n','140','mm'],['Retraction length','n','0.8','mm'],['Retraction speed','n','30','mm/s'],['Z hop','n','0.4','mm']]),
      S('Motion ability', [['Max speed X','n','500','mm/s'],['Max speed Y','n','500','mm/s'],['Max speed Z','n','20','mm/s'],['Max speed E','n','30','mm/s'],['Max accel X','n','20000','mm/s²'],['Max accel Y','n','20000','mm/s²'],['Max accel Z','n','200','mm/s²'],['Max jerk X','n','9','mm/s'],['Max jerk Y','n','9','mm/s']]),
    ]},
    { id:'gcode', label:'G-code', sections:[
      S('Machine G-code', [['Start G-code','t','G28 ;home',''],['End G-code','t','M104 S0',''],['Before layer change','t','—',''],['Layer change G-code','t','—',''],['Pause G-code','t','M0',''],['Resume G-code','t','—',''],['Change filament','t','M600',''],['Between objects','t','—','']]),
      S('Advanced', [['Emit temperature commands','b','On',''],['G-code flavor','e','Marlin',''],['Silent mode','b','Off',''],['Use relative E distances','b','On',''],['Use firmware retraction','b','Off','']]),
    ]},
  ],
};
