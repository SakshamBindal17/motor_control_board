import sys, json, os

sys.path.append(os.path.abspath('backend'))

from calculations import CalculationEngine

calc = CalculationEngine({'v_bus_v': 48}, {}, {}, {}, {}, {})
calc.driver = {"part_number": "UCC21520", "io_source": 4.0}
calc.mosfet = {"part_number": "IPB014N06N", "qg": 120e-9, "rg_int": 1.2}
calc.mcu = {"part_number": "STM32G4", "adc_vref": 3.3}
calc.v_drv = 12.0
calc.i_max = 50.0
calc.ovr = {}

res = calc.calc_cross_validation()

with open('out.json', 'w') as f:
    json.dump(res, f, indent=2)
