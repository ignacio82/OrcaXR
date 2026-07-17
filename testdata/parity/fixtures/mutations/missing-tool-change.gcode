; OrcaXR synthetic semantic G-code fixture. DO NOT PRINT.
; estimated printing time (normal mode) = 42s
; total filament used [mm] = 7.5
; total filament used [g] = 0.02
; WARNING: Synthetic fixture warning
G21
G90
M82
M104 S210 T0
M109 S210 T0
M140 S60
M190 S60
T0
;LAYER_CHANGE
;Z:0.20
;TYPE:Outer wall
G92 E0
G1 X0 Y0 Z0.2 F1200
G1 X10 Y0 E1.0
G1 X10 Y10 E2.0
;TYPE:Sparse infill
G1 X0 Y10 E2.5
;LAYER_CHANGE
;Z:0.40
M104 S215 T1
;TYPE:Prime tower
; WIPE_TOWER_START
G92 E0
G1 X12 Y12 Z0.4 E0.5
; WIPE_TOWER_END
;TYPE:Inner wall
M83
G1 X0 Y0 E1.5
G1 X5 Y5 E-0.2
G1 X10 Y10 E3.0
M82
M141 S35
M191 S35
