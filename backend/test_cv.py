import sys
import traceback
import json
import os

sys.path.append(os.path.abspath('backend'))

from calc_engine import MotorCalculator

calc = MotorCalculator()
calc.driver = {"part_number": "UCC21520", "io_source": 4.0}
calc.mosfet = {"part_number": "IPB014N06N", "qg": 120e-9, "rg_int": 1.2}
calc.mcu = {"part_number": "STM32G4", "adc_vref": 3.3}
calc.v_drv = 12.0
calc.i_max = 50.0

try:
    calc.calc_cross_validation()
    print("Done")
except Exception as e:
    traceback.print_exc()
