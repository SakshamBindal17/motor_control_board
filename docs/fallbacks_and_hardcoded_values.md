# MC Hardware Designer v2: Fallbacks and Hardcoded Values Reference

The MC Hardware Designer v2 engine (`calc_engine.py`) employs a robust system of "fallbacks" to ensure calculations succeed even if a datasheet parameter cannot be extracted. Furthermore, the engine relies on hardcoded engineering constants to establish baselines for thermal, protection, and PCB analysis.

This document serves as the absolute reference for every fallback and hardcoded constant injected into the calculations.

---

## 1. Safety and Protection Constants (Hardcoded)

These constants are not configurable via the UI and represent strict design decisions for a generic 48V Motor Controller architecture.

### Over-Voltage Protection (OVP)
- **Trip Point:** Fixed at **`Peak Voltage (V_peak) + 3%`** (e.g., for 60V, trips at 61.8V).
- **Upper Divider Resistor ($R_1$):** Hardcoded to **`100 kΩ`**.
- **Comparator Reference:** Assumes a standard **`3.3V`** reference.
- **Hardware Response Time Assumption:** `1.0 µs` to disable PWM.

### Under-Voltage Protection (UVP)
- **Trip Point:** Fixed at **`75% of Nominal Bus Voltage (V_bus)`** (e.g., for 48V, trips at 36V).
- **Hysteresis Re-enable Point:** Fixed at **`79% of V_bus`** (provides ~2V gap to prevent chattering).
- **Upper Divider Resistor ($R_1$):** Hardcoded to **`100 kΩ`**.

### Over-Current Protection (OCP)
- **Hardware Trip Point (Driver IC / Comparator):** **`125% of Max Phase Current`**.
- **Software Warning Point (MCU):** **`110% of Max Phase Current`**.
- **Hardware Response Time:** `1.0 µs`.
- **Software Response Time:** `10.0 µs`.

### Over-Temperature Protection (OTP)
- **NTC Part Choice:** Assumes a standard **`Murata NCP15 (10kΩ @ 25°C, B-value = 3950)`**.
- **Pull-up Resistor:** Hardcoded to **`10 kΩ`**.
- **Warning Threshold:** **`80 °C`**.
- **Shutdown Threshold:** **`100 °C`**.

---

## 2. Component Parameter Fallbacks

If `claude_service.py` fails to extract a value from the loaded PDF datasheets, `calc_engine.py` inserts these default fallback estimates before performing the mathematics. 

### A. MOSFET Fallbacks
*If not found in the MOSFET datasheet:*
- **$R_{DS(on)}$ (On-state Resistance):** `1.5 mΩ` (0.0015 Ω)
- **$Q_g$ (Total Gate Charge):** `92 nC`
- **$Q_{gd}$ (Gate-Drain Charge / Miller):** `30 nC`
- **$t_r$ (Rise Time):** `30 ns`
- **$t_f$ (Fall Time):** `20 ns`
- **$t_{d\_off}$ (Turn-Off Delay Time):** `50 ns`
- **$V_{gs(th)}$ (Gate Threshold Voltage):** `3.0 V`
- **$C_{iss}$ (Input Capacitance):** `3000 pF`
- **$C_{oss}$ (Output Capacitance):** `200 pF`
- **$Q_{rr}$ (Reverse Recovery Charge):** `44 nC`
- **$R_{\theta JC}$ (Junction-to-Case Thermal Resistance):** `0.5 °C/W`
- **$T_{j(max)}$ (Max Junction Temperature):** `175 °C`

### B. Gate Driver Fallbacks
*If not found in the Driver datasheet:*
- **$I_{source}$ (Peak Source Current):** `1.5 A`
- **$I_{sink}$ (Peak Sink Current):** `2.5 A`
- **$t_{prop\_on}$ (Propagation Delay ON):** `60 ns`
- **$t_{prop\_off}$ (Propagation Delay OFF):** `60 ns`
- **$A_{CSA}$ (Current Sense Amplifier Gain):** `20 V/V` (or 20x)

### C. MCU Fallbacks
*If not found in the MCU datasheet:*
- **ADC Resolution:** `12 bits`
- **PWM Dead-Time Resolution:** `8 ns` (0.000000008 s)
- **Max Programmable Dead-Time:** `1000 ns` (0.000001 s)

---

## 3. Passive Estimation Constants

The system uses rules of thumb to size "good enough" passive components if no specific override is provided.

### Bulk Bus Capacitance
- **Ripple Calculation Method:** If the motor's phase inductance (`Lph`) is left blank, the engine uses a generic 3-phase SPWM mathematical estimation assuming a modulation index of $M = 0.9$ to calculate RMS bus ripple. 
- **Electrolytic Cap ESR:** Assumes a standard electrolytic equivalent series resistance (ESR) of **`50 mΩ`** to calculate capacitor self-heating and power dissipation.
- **Minimum Quantity:** Will always recommend at least **`4 x 100µF`** capacitors physically, regardless of calculations.

### Bootstrap Capacitor
- **Refresh Dropout Allowance:** Tolerates a **`0.5V droop`** on the bootstrap capacitor between PWM refresh cycles (can be overridden).
- **Leakage Current Budget:** Assumes **`3.0 µA`** of combined gate leakage and driver quiescent current draining the bootstrap capacitor during 100% duty-cycle operation bounds.
- **Series Resistor:** Recommends a fixed **`10 Ω`** series resistor for charging the capacitor.
- **Diode Forward Drop:** Uses a fixed **`0.5 V`** voltage drop for the bootstrap diode (`B0540W` Schottky).

### Snubber Circuit
- **PCB Parasitic Trace Inductance:** Unless overridden in the Passives UI, assumes a worst-case **`10 nH`** stray loop inductance between the DC Bus and Half-Bridge. 
- **Capacitor Sizing:** Targets a snubber capacitance ($C_s$) of approximately **`3 × $C_{oss}$`** of the MOSFET.
- **Resistor Sizing:** Targets Critical Damping ($R_s = \sqrt{L/C_{oss}}$). It enforces a strict boundary range of a minimum **`1.0 Ω`** and a maximum **`100.0 Ω`**.

### EMI Filter
- **Common Mode Choke:** Fixed target inductance of **`330 µH`**.
- **Choke DC Resistance (DCR):** Assumes an unavoidable **`5 mΩ`** DCR penalty used to calculate insertion loss wattage.
- **X-Capacitor (Differential):** Fixed at **`100 nF`**.
- **Y-Capacitor (CM to chassis):** Fixed at **`4.7 nF`** to respect leakage current limits.

### PCB Traces & Thermal Flow
- **Thermal Resistance Case-to-Solder ($R_{\theta CS}$):** Fixed at **`0.5 °C/W`**.
- **Thermal Resistance PCB-to-Ambient ($R_{\theta SA}$):** Fixed at **`20.0 °C/W`** simulating a reasonably sized 2oz/3oz copper pour with natural convection and no forced airflow.
- **PCB Trace Sizing standard:** Calculates trace widths mathematically based on **IPC-2152** for external layers, assuming **3oz copper** and allowing a **30°C temperature rise**.

---

## 4. Derived & System Scaling Logic

- **$R_{DS(on)}$ Temperature Derating:** When calculating conduction losses, the $R_{DS(on)}$ is permanently multiplied by a factor of **1.5x**. This strictly mimics the operating resistance of silicon at $\sim100^\circ\text{C}$ junction temperature rather than the datasheet specification at $25^\circ\text{C}$.
- **Standard Resistor Decades (E-Series):** The engine rounds continuous mathematical values to nearest real-world manufacturable parts.
    - Gate Resistors, Protection Dividers: Snap to **`E24`** Series.
    - Capacitors (Snubber, Bootstrap): Snap to **`E12`** Series.
- **Dead-Time Safety Margin:** The actual calculated minimum physical dead-time (turn-off delay + fall time + propagation delay + 20ns baseline margin) is multiplied by **`1.5x`** (a 50% safety margin) before recommending a register count to the MCU.
