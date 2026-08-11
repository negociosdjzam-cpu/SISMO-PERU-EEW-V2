# V2 test results

## Static checks
- Node `server.js`: syntax OK.
- Node `sensorLab.js`: syntax OK.
- Existing FusionEngine smoke test: PASS.
- Python waveform-gateway files: `py_compile` PASS.
- ZIP integrity: PASS.

## Multi-station P-arrival simulation
Synthetic origin near central Peru, 5 stations, P velocity 6 km/s.

Result from SensorLab V2:
- `stationCount`: 5
- `residualRmsSec`: 0.308 s
- `confidence`: 0.75
- candidate emitted successfully
- target arrivals for Huancayo calculated successfully

The synthetic test intentionally demonstrates a limitation too: depth can trade off strongly against origin time/location in a simple homogeneous P-only model. Therefore depth and arrival countdown remain explicitly experimental until a calibrated regional velocity model / mature locator is added.
