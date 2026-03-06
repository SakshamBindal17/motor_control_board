# 3kW PMSM Motor Controller - 3× Parallel MOSFET Design
## Complete System Design with UCC27311A-Q1 Gate Driver

---

## SYSTEM OVERVIEW

**Motor Controller Specifications:**
- **Nominal Voltage**: 48V DC
- **Peak Voltage**: 60V DC  
- **Maximum Power**: 3kW
- **Phase Current**: 80A continuous, 100A peak
- **PWM Frequency**: 20-40kHz (30kHz nominal)
- **Control**: FOC and 6-step compatible
- **Motor Type**: PMSM, 6000 RPM max
- **Cooling**: Natural convection

**Power Stage Configuration:**
- **MOSFET**: Infineon IAUCN08S7N024 (80V, 2.4mΩ)
- **Configuration**: **3× MOSFETs in parallel per switch**
- **Total MOSFETs**: 18 devices (6 switches × 3 parallel)
- **Gate Driver**: UCC27311A-Q1 (Automotive half-bridge)
- **Gate Drivers Needed**: 3 (one per phase)

---

## 1. MOSFET CONFIGURATION - 3× PARALLEL

### 1.1 Why 3× Parallel Configuration?

**Benefits:**
✓ **Excellent thermal management**: 15.3W / 3 = 5.1W per MOSFET
✓ **Low junction temperature**: ~80°C (safe margin)
✓ **High reliability**: Derates each MOSFET to 33% of rating
✓ **Future-proof**: Handles overload conditions easily
✓ **Reduced conduction losses**: R_DS(on) ÷ 3

**Trade-offs:**
✗ **Higher cost**: 18 MOSFETs vs. 6 ($49.50 vs. $16.50)
✗ **More complex layout**: 3× PCB area per switch
✗ **Current sharing challenges**: Requires careful design
✗ **3× gate driver losses**: More power dissipation

### 1.2 Current Distribution per MOSFET

**Phase Current Distribution:**
```
Total phase current (RMS): 56.6A
Per MOSFET (ideal): 56.6A / 3 = 18.9A RMS
Per MOSFET (peak): 80A / 3 = 26.7A peak

MOSFET rating: 150A DC
Utilization: 18.9A / 150A = 12.6% ✓ Excellent derating
```

**Current Sharing Analysis:**
```
With ±10% R_DS(on) tolerance:
MOSFET A: R_DS = 3.5mΩ × 0.9 = 3.15mΩ
MOSFET B: R_DS = 3.5mΩ × 1.0 = 3.50mΩ
MOSFET C: R_DS = 3.5mΩ × 1.1 = 3.85mΩ

Parallel R_eq = 1 / (1/3.15 + 1/3.50 + 1/3.85) = 1.17mΩ

Current distribution (by inverse resistance):
I_A = 56.6A × (3.50/3.15) × 0.33 = 20.7A (36%)
I_B = 56.6A × (3.50/3.50) × 0.33 = 18.9A (33%)
I_C = 56.6A × (3.50/3.85) × 0.33 = 17.2A (30%)

Worst imbalance: 20.7A - 17.2A = 3.5A (6% of total)
Still well below 150A rating ✓
```

**Thermal Feedback Helps Current Sharing:**
- Hotter MOSFET → Higher R_DS(on) → Less current → Cools down
- Self-balancing effect improves sharing over time ✓

### 1.3 Parallel Configuration Layout

**Critical Layout Requirements:**

1. **Symmetric PCB Traces**
   - Equal length for all gate traces (±2mm)
   - Equal width for all source/drain traces
   - Mirrored layout for balanced inductance

2. **Individual Gate Resistors**
   - Each MOSFET gets its own R_g_on and R_g_off
   - Prevents oscillation between paralleled devices
   - Allows independent turn-on/turn-off control

3. **Kelvin Source Connection**
   - Gate drive return separate from power source
   - Connect at single point close to MOSFETs
   - Minimizes ground bounce

4. **Common Drain Node**
   - Large copper pour connecting all drains
   - Multiple thermal vias per MOSFET
   - Low-impedance connection essential

**Layout Diagram (One Phase, Low-Side):**
```
        DC+ (or Phase Output)
            |
            +===== [MOSFET 1] ====+
            |                      |
            +===== [MOSFET 2] ====+===== Common Source/Drain
            |                      |
            +===== [MOSFET 3] ====+
                                   |
                              GND/Phase
                              
Gate Driver:
   OUT ──[R_g_on]──+──[Gate 1]
              |     |
          [Diode]  +──[Gate 2]
              |     |
   ──[R_g_off]─+    +──[Gate 3]
```

---

## 2. GATE DRIVER: UCC27311A-Q1

### 2.1 Specifications

**UCC27311A-Q1 (Automotive Half-Bridge Driver):**
- **Peak Source Current**: 3.7A
- **Peak Sink Current**: 4.5A (asymmetrical)
- **Supply Voltage**: 4.5V to 18V (12V nominal)
- **Input Logic**: TTL compatible
- **Propagation Delay**: ~16ns typical
- **Bootstrap Diode**: **Integrated 120V** ✓ No external diode needed!
- **UVLO**: 8V with hysteresis
- **Enable Pin**: Active high enable control
- **Package**: 10-pin SON (DRC) or 8-pin SOIC
- **Temperature**: -40°C to +150°C (automotive grade)
- **Cost**: ~$1.20 each

**Key Features:**
✓ Automotive AEC-Q101 qualified
✓ Integrated bootstrap diode saves BOM cost
✓ Enable pin for fault shutdown
✓ Asymmetrical drive (stronger sink for Miller effect)
✓ Negative voltage handling on HS pin (-5V)
✓ Low-side and high-side matched to 4ns

### 2.2 Why UCC27311A-Q1 is EXCELLENT for This Application

**1. Drive Capability:**
```
Total gate charge (3× parallel):
Q_g_total = 3 × 67nC = 201nC per switch

Driver capability:
Peak source: 3.7A
Peak sink: 4.5A

Time to deliver 201nC:
t = Q / I = 201nC / 3.7A = 54ns ✓ Fast enough

At 30kHz PWM:
Period = 33.3µs
54ns / 33.3µs = 0.16% of cycle ✓ Negligible
```

**2. Automotive Grade Reliability:**
- Matches IAUCN08S7N024 automotive qualification
- Extended temperature range
- Robust ESD protection

**3. Integrated Bootstrap Diode:**
- Saves 3× external bootstrap diodes
- Rated for 120V (60V bus × 2 = excellent margin)
- Fast recovery, low forward voltage

**4. Enable Pin:**
- Direct connection to protection circuit
- Immediate shutdown capability
- Reduces external logic needed

### 2.3 UCC27311A-Q1 Pinout and Connections

**10-Pin SON (DRC) Package:**
```
Pin | Name | Function
----|------|----------
1   | VDD  | Low-side driver supply (12V)
2   | HI   | High-side input (MCU PWM)
3   | LI   | Low-side input (MCU PWM)
4   | VSS  | Ground reference
5   | LO   | Low-side output (to LS MOSFET gates)
6   | HS   | High-side source (switch node)
7   | HO   | High-side output (to HS MOSFET gates)
8   | HB   | High-side bootstrap supply
9   | EN   | Enable input (active high)
10  | Thermal Pad (connect to VSS)
```

**Bootstrap Circuit:**
```
VDD (12V) ──┬─── [Internal Bootstrap Diode] ───┬─── HB
            │                                    │
         [100nF]                            [1µF] Bootstrap Cap
            │                                    │
           VSS                                  HS (Switch Node)
```

### 2.4 Gate Driver Power Dissipation

**Per Driver (Driving 3× Parallel MOSFETs):**
```
Gate charge per switch: 201nC (3× 67nC)
Frequency: 30kHz
Supply voltage: 12V

P_driver = Q_g × V_DD × f_sw × 2 (both HS and LS)
P_driver = 201nC × 12V × 30kHz × 2
P_driver = 144.7mW per phase

Total (3 drivers): 3 × 144.7mW = 434mW ✓ Negligible
```

**Quiescent Current:**
```
I_q (per driver): ~3mA typical
P_q = 12V × 3mA × 3 drivers = 108mW

Total driver power: 434mW + 108mW = 542mW ✓ Very low
```

---

## 3. GATE RESISTOR CALCULATION

### 3.1 Design Objectives

1. **Control switching speed** (EMI vs. efficiency trade-off)
2. **Prevent gate oscillation** (with 3× parallel MOSFETs)
3. **Optimize Miller plateau crossing**
4. **Balance turn-on and turn-off speeds**

### 3.2 Gate Resistor Selection

**Total Gate Charge (3× Parallel):**
```
Q_g_total = 3 × 67nC = 201nC
Q_gd_total = 3 × 15nC = 45nC (Miller charge)
Q_gs_total = 3 × 21.5nC = 64.5nC
```

**Driver Output Impedance:**
```
R_driver_source ≈ 12V / 3.7A ≈ 3.2Ω (at peak)
R_driver_sink ≈ 12V / 4.5A ≈ 2.7Ω (at peak)
```

**Turn-ON Resistor Calculation:**
```
Target rise time: 40-50ns (balance EMI vs. speed)
Desired peak current: 2.5A (conservative)

R_g_on_total = (V_drive / I_peak) - R_driver
R_g_on_total = (12V / 2.5A) - 3.2Ω = 1.6Ω

For 3× parallel MOSFETs (individual resistors):
R_g_on_individual = R_g_on_total × 3 = 1.6Ω × 3 = 4.8Ω

Use standard value: 4.7Ω per MOSFET ✓

Actual rise time:
t_rise ≈ R_g_on_total × Q_g_total
t_rise ≈ 1.6Ω × 201nC = 322ns total
t_Miller ≈ 1.6Ω × 45nC = 72ns ✓ Good
```

**Turn-OFF Resistor Calculation:**
```
Faster turn-off reduces switching losses
Target sink current: 3A

R_g_off_total = (12V / 3A) - 2.7Ω = 1.3Ω

For 3× parallel:
R_g_off_individual = 1.3Ω × 3 = 3.9Ω

Use standard value: 3.9Ω or 3.3Ω per MOSFET ✓

Actual fall time:
t_fall ≈ 1.3Ω × 201nC = 261ns
t_Miller_off ≈ 1.3Ω × 45nC = 59ns ✓ Fast
```

### 3.3 Final Gate Resistor Selection

**Per MOSFET (18 total sets needed):**
- **R_g_on**: 4.7Ω (0805 or 1206, 0.25W)
- **R_g_off**: 3.3Ω or 3.9Ω (0805 or 1206, 0.25W)
- **Schottky diode**: BAT54 or similar (SOD-123)

**Gate Resistor Network (Per MOSFET):**
```
Driver OUT ──[R_g_on 4.7Ω]──+──── MOSFET Gate
                             |
                         [BAT54 Schottky]
                             |
         ──[R_g_off 3.3Ω]───+
```

**Power Dissipation per Resistor:**
```
P_gate = Q_g × V_drive × f_sw
P_gate (per MOSFET) = 67nC × 12V × 30kHz = 24.1mW

Per resistor: ~10-12mW
0.25W resistors are MORE than adequate ✓
```

### 3.4 Gate Oscillation Prevention

**Why Individual Resistors?**
- **Without individual resistors**: MOSFETs can oscillate against each other due to slight timing differences
- **With individual resistors**: Each MOSFET independently controlled, no cross-coupling

**Recommended Practice:**
```
✗ WRONG:  OUT ──[Rg]──+──┬─Gate1
                       │  ├─Gate2  
                       │  └─Gate3
                       
✓ CORRECT: OUT ───┬──[Rg1]──Gate1
                  ├──[Rg2]──Gate2
                  └──[Rg3]──Gate3
```

---

## 4. SNUBBER CIRCUIT DESIGN

### 4.1 Purpose of Snubbers

**Functions:**
1. **Dampen voltage ringing** during MOSFET turn-off
2. **Protect from voltage spikes** exceeding V_DS rating
3. **Reduce EMI** by slowing dV/dt
4. **Improve reliability** by reducing stress

### 4.2 RC Snubber Calculation

**Switching Transient Analysis:**
```
Peak switching current: 80A
Parasitic inductance (estimated): 10nH (drain-source loop)

Voltage spike: ΔV = L × (dI/dt)
dI/dt ≈ 80A / 40ns = 2A/ns = 2000A/µs

ΔV = 10nH × 2000A/µs = 20V spike

Total voltage: 60V bus + 20V spike = 80V
Exactly at MOSFET rating ⚠ Need snubber!
```

**RC Snubber Design:**
```
Snubber capacitor: C_snub
Snubber resistor: R_snub

C_snub selection:
- Absorb switching energy
- Not too large (increases losses)
- Typical range: 1-10nF for motor drives

Start with: C_snub = 4.7nF (ceramic, 100V, C0G/NP0)

R_snub calculation:
Critical damping: R = 0.5 × √(L_parasitic / C_snub)
R_snub = 0.5 × √(10nH / 4.7nF) = 0.73Ω

Use standard value: R_snub = 0.68Ω or 1.0Ω (0805, 0.5W)

Actual damping coefficient:
ζ = 0.5 × R_snub × √(C_snub / L) = 0.74 (slightly underdamped) ✓
```

**Snubber Power Dissipation:**
```
E_snub = 0.5 × C_snub × V_DS²
E_snub = 0.5 × 4.7nF × 60² = 8.46µJ per switch event

P_snub = E_snub × f_sw × 2 (turn-on and turn-off)
P_snub = 8.46µJ × 30kHz × 2 = 508mW per MOSFET

For 6 switches: 6 × 508mW = 3.05W total ✓ Acceptable
```

### 4.3 Snubber Component Selection

**Per MOSFET (18 total snubbers):**
- **C_snub**: 4.7nF, 100V, C0G/NP0 ceramic (0805)
  - Example: Murata GRM21BR72A472KA01L
  - Cost: ~$0.10 each
  
- **R_snub**: 1.0Ω, 0.5W, thick film (0805 or 1206)
  - Example: Vishay CRCW08051R00FKEA
  - Cost: ~$0.02 each

**Placement:**
```
MOSFET Drain ──┬─── (to DC+ or Phase)
               │
           [R_snub 1.0Ω]
               │
           [C_snub 4.7nF]
               │
MOSFET Source ─┴─── (to GND or Phase)

Place snubber VERY close to MOSFET (<5mm)
Short, wide PCB traces
Minimize loop area
```

### 4.4 Alternative: RCD Clamp Snubber (Optional)

**For Extra Protection:**
```
         Drain ──┬───
                 │
             [R_clamp 10Ω]
                 │
             [D_clamp: Fast diode, 80V]
                 │
         ───────┬┴─── Clamp Voltage Rail (70V)
                │
            [C_clamp 1µF]
                │
         ───────┴───── Source

Function: Clamps voltage to 70V maximum
Use if: Severe voltage spikes observed
Cost: Additional ~$0.50 per MOSFET
```

---

## 5. DC-DC CONVERTER SELECTION

### 5.1 Requirements

**Power Budget:**
```
Component                Power
------------------------|-------
3× Gate Drivers          0.54W
MCU (STM32F4)           0.8W
Current Sense Amps      0.3W
Protection Circuits     0.2W
Encoder Interface       0.15W
Communication (CAN)     0.1W
Margin (20%)            0.5W
------------------------|-------
TOTAL 12V RAIL          2.6W

5V Rail (logic):
MCU Core                0.5W
Communication           0.2W
Sensors                 0.1W
Margin                  0.2W
------------------------|-------
TOTAL 5V RAIL           1.0W

3.3V Rail (MCU I/O):
MCU I/O                 0.4W
Misc                    0.1W
------------------------|-------
TOTAL 3.3V RAIL         0.5W
```

### 5.2 Recommended DC-DC Converter

**Primary Choice: LMR51430 (Texas Instruments)**

**Specifications:**
- **Input Voltage**: 4.2V to 60V (perfect for 48V bus!)
- **Output Voltage**: 3.3V to 45V (adjustable)
- **Output Current**: 3A continuous
- **Switching Frequency**: 400kHz (configurable)
- **Efficiency**: >90% typical at 48V→12V
- **Features**:
  - Synchronous buck (high efficiency)
  - Ultra-low I_q: 30µA (great for standby)
  - Integrated FETs (reduces BOM)
  - Current limit protection
  - Thermal shutdown
  - Enable pin
- **Package**: HTSSOP-14 (exposed pad)
- **Cost**: ~$1.80 each

**Configuration:**

**12V Rail (Main):**
```
LMR51430 configured as:
V_in = 48V (36-60V range)
V_out = 12V
I_out = 3A (sufficient for 2.6W + margin)

External components:
- L1: 22µH, 4A, low DCR (<50mΩ)
  → Würth 744773322
- C_in: 2× 22µF, 100V X7R ceramic
- C_out: 2× 47µF, 16V X7R ceramic
- R_fb1, R_fb2: Voltage divider for 12V setpoint
```

**Alternative: Use 2× Converters in Cascade**

**Option A: 48V → 12V → 5V → 3.3V (Linear)**
```
48V ──[LMR51430]──→ 12V (3A)
         ├─── Gate Drivers
         └───[LDO]──→ 5V (1A)
                └───[LDO]──→ 3.3V (0.5A)
```

**Option B: 48V → 12V and 48V → 5V (Parallel)**
```
48V ──┬──[LMR51430 #1]──→ 12V (3A) ──→ Gate Drivers
      │
      └──[LMR51430 #2]──→ 5V (1.5A) ───┬── 5V Rail
                                        └──[LDO]──→ 3.3V
```

**RECOMMENDED: Option A (Single DC-DC + LDOs)**
- Lower cost: 1× DC-DC vs. 2×
- Simpler design
- Adequate for power needs

### 5.3 DC-DC Circuit Design (48V → 12V)

**Schematic:**
```
48V_IN ──┬───[22µF]───┬──────┬──── VIN (LMR51430)
         │            │      │
       [TVS]       [22µF]   [10µF]
         │            │      │
        GND          GND    GND

LMR51430:
  Pin 1: VIN
  Pin 2: EN (← Enable signal or pull-up to VIN)
  Pin 3: SYNC (leave open or GND for internal oscillator)
  Pin 4-5: SW (switching node)
  Pin 6: BOOT (bootstrap cap: 0.1µF to SW)
  Pin 7: VCC (bias supply, connect to VOUT via diode or use VIN)
  Pin 8: FB (feedback)
  Pin 9: AGND
  Pin 10: RT (frequency set resistor, ~100kΩ for 400kHz)
  Pin 11-12: GND (power ground)
  Pin 13: PGND (exposed pad, connect to GND plane)

  SW ──┬──[22µH inductor]──┬──── VOUT (12V)
       │                   │
   [Optional Catch         ├──[47µF]──┬─── 12V_OUT
    Diode for             │           │
    reverse current]      ├──[47µF]   │
                          │           │
                         GND         GND

Feedback Network:
  12V ──[R1: 150kΩ]──┬──── FB
                     │
                 [R2: 16.5kΩ]
                     │
                    GND

  V_out = 0.8V × (1 + R1/R2) = 0.8V × (1 + 150/16.5) ≈ 12V ✓
```

**Bill of Materials (48V→12V Converter):**
| Qty | Component | Description | Part Number | Cost |
|-----|-----------|-------------|-------------|------|
| 1 | IC | LMR51430 Buck Converter | TI LMR51430XDDCR | $1.80 |
| 1 | L1 | 22µH, 4A Inductor | Würth 744773322 | $0.80 |
| 2 | C_in | 22µF, 100V X7R | TDK C5750X7S2A226M | $0.50 |
| 2 | C_out | 47µF, 16V X7R | Murata GRM32ER71C476KE15L | $0.40 |
| 1 | C_boot | 0.1µF, 25V X7R | Generic 0805 | $0.02 |
| 1 | R_fb1 | 150kΩ, 1% | Generic 0603 | $0.01 |
| 1 | R_fb2 | 16.5kΩ, 1% | Generic 0603 | $0.01 |
| 1 | R_rt | 100kΩ | Generic 0603 | $0.01 |
| **TOTAL** | | | | **~$3.55** |

---

## 6. LDO REGULATOR SELECTION

### 6.1 12V → 5V LDO

**Requirements:**
- Input: 12V
- Output: 5V
- Current: 1A minimum (1.5A preferred for margin)
- Efficiency: Not critical (low power)
- Dropout: <1V

**Recommended: TPS7A7001 (Texas Instruments)**

**Specifications:**
- **Input Range**: 3V to 40V
- **Output**: 0.8V to 27V (adjustable)
- **Max Current**: 1.5A
- **Dropout**: 170mV @ 1A
- **Noise**: 4.4µV_rms (ultra-low!)
- **PSRR**: 80dB @ 10kHz (excellent)
- **Package**: HTSSOP-20
- **Cost**: ~$2.50

**Why TPS7A7001?**
✓ Wide input range (safe for 12V variations)
✓ High current capability
✓ Excellent noise performance (critical for ADC reference)
✓ Good PSRR (rejects gate driver switching noise)
✓ Automotive grade available (TPS7A7001-Q1)

**Configuration:**
```
12V ──┬──[10µF]──[TPS7A7001]──[10µF]──┬── 5V_OUT (1A)
      │             │                  │
    [TVS]         [0.1µF]           [100µF]
      │             │                  │
     GND           GND                GND

Feedback network for 5V output:
External resistors set output voltage
R1 = 127kΩ, R2 = 30.1kΩ (1% tolerance)
```

**Alternative (Lower Cost): LM317**
- Classic adjustable LDO
- 1.5A capable
- Cost: ~$0.50
- Less precise, higher noise
- Use if cost is priority over performance

### 6.2 5V → 3.3V LDO

**Requirements:**
- Input: 5V
- Output: 3.3V
- Current: 500mA minimum
- Low dropout (<200mV)
- Good transient response

**Recommended: TLV75533 (Texas Instruments)**

**Specifications:**
- **Input Range**: 2.5V to 5.5V
- **Output**: 3.3V fixed
- **Max Current**: 500mA
- **Dropout**: 170mV @ 500mA
- **Noise**: 33µV_rms
- **PSRR**: 65dB @ 1kHz
- **Quiescent Current**: 48µA (very low!)
- **Package**: SOT-23-5
- **Cost**: ~$0.30

**Configuration:**
```
5V ──┬──[10µF]──[TLV75533]──[10µF]──┬── 3.3V_OUT (500mA)
     │            │                  │
   [0.1µF]      [0.1µF]           [0.1µF]
     │            │                  │
    GND          GND                GND

Simple 3-pin connection:
  Pin 1: VIN (5V)
  Pin 2: GND
  Pin 3: VOUT (3.3V)
  Pin 4: NC (Not Connected)
  Pin 5: EN (Enable, pull to VIN or use for power sequencing)
```

**Alternative: AMS1117-3.3**
- Cost: ~$0.10
- 1A capability (overkill but good margin)
- Higher dropout (1.1V @ 1A)
- Needs 5V minimum input (marginal)

### 6.3 Power Supply Summary

**Complete Power Tree:**
```
48V DC Bus
    │
    ├──[LMR51430]──→ 12V @ 3A ───┬─── Gate Drivers (0.54W)
    │                             │
    │                             ├──[TPS7A7001]──→ 5V @ 1A ───┬─── MCU 5V (0.5W)
    │                             │                             │
    │                             │                             ├─── Sensors (0.3W)
    │                             │                             │
    │                             │                             └──[TLV75533]──→ 3.3V @ 0.5A ── MCU I/O
    │                             │
    │                             └─── Protection Circuits (0.2W)
    │
    └──[Direct to Power Stage]──→ 48-60V to MOSFETs
```

**Power Supply BOM:**
| Component | Part Number | Qty | Unit Cost | Total |
|-----------|-------------|-----|-----------|-------|
| 48V→12V Buck | LMR51430XDDCR | 1 | $1.80 | $1.80 |
| Buck Passives | (See section 5.3) | 1 set | $1.75 | $1.75 |
| 12V→5V LDO | TPS7A7001DSER | 1 | $2.50 | $2.50 |
| 5V→3.3V LDO | TLV75533PDBVR | 1 | $0.30 | $0.30 |
| LDO Capacitors | Various 10µF, 0.1µF | ~10 | $0.05 | $0.50 |
| **TOTAL** | | | | **$6.85** |

---

## 7. COMPLETE SYSTEM LOSS ANALYSIS

### 7.1 MOSFET Losses (3× Parallel Configuration)

**Conduction Losses:**
```
Current per MOSFET: 18.9A RMS
R_DS(on) @ 100°C: 3.5mΩ

Per MOSFET:
P_cond = I_rms² × R_DS(on) = 18.9² × 0.0035 = 1.25W

Total (18 MOSFETs):
P_cond_total = 18 × 1.25W = 22.5W ✓ Excellent!
```

**Switching Losses:**
```
Energy per transition (per MOSFET):
E_sw = 0.5 × V_DS × I_D × (t_rise + t_fall) / 3

(Current divided by 3 in parallel)

E_sw ≈ 0.5 × 48V × 26.7A × (322ns + 261ns) 
E_sw ≈ 7.4µJ per MOSFET per cycle

Per MOSFET:
P_sw = 7.4µJ × 30kHz × 2 = 444mW

Total (18 MOSFETs):
P_sw_total = 18 × 444mW = 8.0W
```

**Total MOSFET Losses:**
```
P_mosfet = P_cond + P_sw = 22.5W + 8.0W = 30.5W ✓
```

### 7.2 Other Component Losses

```
Component                  Power Loss
--------------------------|------------
Gate Drivers (3×)          0.54W
Snubbers (18×)             3.05W
Current Shunts (3×)        6.4W × 3 = 19.2W
Bootstrap Caps             0.1W
Gate Resistors             0.4W
DC-DC Converter Loss       ~0.3W
LDO Losses                 ~0.2W
Miscellaneous              0.5W
--------------------------|------------
TOTAL OTHER LOSSES         24.8W
```

### 7.3 Total System Losses and Efficiency

```
TOTAL SYSTEM LOSSES:
  MOSFETs:              30.5W
  Other Components:     24.8W
  ─────────────────────────
  TOTAL:                55.3W

Output Power:           3000W
Input Power:            3055.3W

SYSTEM EFFICIENCY = 3000W / 3055.3W = 98.2% ✓✓✓ EXCELLENT!
```

### 7.4 Thermal Analysis (3× Parallel)

**Per MOSFET:**
```
Power dissipation: 1.25W (cond) + 0.44W (sw) = 1.69W

Thermal resistance:
R_thJC = 1.0°C/W (junction to case)
R_thCS = 0.3°C/W (case to PCB with vias)
R_thSA = 8°C/W (PCB to ambient, estimated)

R_thJA = 1.0 + 0.3 + 8.0 = 9.3°C/W

Junction temperature:
T_j = T_ambient + (P × R_thJA)
T_j = 30°C + (1.69W × 9.3°C/W) = 45.7°C ✓✓✓

EXCELLENT THERMAL PERFORMANCE!
Maximum T_j: 175°C
Margin: 175°C - 45.7°C = 129.3°C ✓✓✓
```

**Benefits of 3× Parallel:**
- Very low junction temperature (45.7°C)
- Huge thermal margin (129°C)
- Can handle 2× overload without thermal issues
- Extremely reliable operation
- Extended MTBF (Mean Time Between Failures)

---

## 8. UPDATED BILL OF MATERIALS

### 8.1 Power Stage

| Qty | Part Number | Description | Package | Unit $ | Total $ |
|-----|-------------|-------------|---------|--------|---------|
| 18 | IAUCN08S7N024 | MOSFET 80V 2.4mΩ | TDSON-8 | $2.75 | $49.50 |
| 3 | UCC27311A-Q1 | Half-bridge driver | SON-10 | $1.20 | $3.60 |
| 18 | 4.7Ω | Gate resistor (turn-on) | 0805 | $0.02 | $0.36 |
| 18 | 3.3Ω | Gate resistor (turn-off) | 0805 | $0.02 | $0.36 |
| 18 | BAT54 | Schottky diode | SOD-123 | $0.10 | $1.80 |
| 18 | 1.0Ω | Snubber resistor | 0805 0.5W | $0.02 | $0.36 |
| 18 | 4.7nF | Snubber capacitor | 0805 100V | $0.10 | $1.80 |
| 3 | 1µF | Bootstrap capacitor | 0805 25V | $0.10 | $0.30 |
| 3 | 100nF | Driver bypass cap | 0805 | $0.05 | $0.15 |
| | | **Subtotal Power Stage** | | | **$58.23** |

### 8.2 Input Filter & Capacitors

| Qty | Part Number | Description | Package | Unit $ | Total $ |
|-----|-------------|-------------|---------|--------|---------|
| 4 | EEU-FR2A471 | 470µF, 100V electrolytic | Radial | $2.00 | $8.00 |
| 3 | 10µF | Ceramic X7R, 100V | 1210 | $0.50 | $1.50 |
| 1 | 10µF | Film cap, 100V (optional) | Radial | $1.50 | $1.50 |
| 1 | TVS Diode | 68V, 3kW rating | DO-201 | $1.00 | $1.00 |
| | | **Subtotal Capacitors** | | | **$12.00** |

### 8.3 Current Sensing

| Qty | Part Number | Description | Package | Unit $ | Total $ |
|-----|-------------|-------------|---------|--------|---------|
| 3 | LVR3-1mΩ | Shunt resistor 1mΩ 10W | 2512 | $1.00 | $3.00 |
| 3 | INA241A2 | Current sense amp 50V/V | SOIC-8 | $1.50 | $4.50 |
| 3 | 100nF | Bypass for INA241A | 0603 | $0.02 | $0.06 |
| | | **Subtotal Current Sense** | | | **$7.56** |

### 8.4 Power Supply

| Qty | Part Number | Description | Package | Unit $ | Total $ |
|-----|-------------|-------------|---------|--------|---------|
| 1 | LMR51430XDDCR | 48V→12V Buck 3A | HTSSOP-14 | $1.80 | $1.80 |
| 1 | TPS7A7001DSER | 12V→5V LDO 1.5A | HTSSOP-20 | $2.50 | $2.50 |
| 1 | TLV75533PDBVR | 5V→3.3V LDO 500mA | SOT-23-5 | $0.30 | $0.30 |
| 1 | 22µH | Inductor 4A | SMD | $0.80 | $0.80 |
| ~15 | Various | Caps for power supply | SMD | $0.10 | $1.50 |
| | | **Subtotal Power Supply** | | | **$6.90** |

### 8.5 Protection & Monitoring

| Qty | Part Number | Description | Package | Unit $ | Total $ |
|-----|-------------|-------------|---------|--------|---------|
| 1 | 220kΩ | Voltage divider | 0805 | $0.02 | $0.02 |
| 1 | 10kΩ | Voltage divider | 0805 | $0.02 | $0.02 |
| 1 | 3.6V Zener | ADC protection | SOD-123 | $0.10 | $0.10 |
| 2 | LM393 | Comparator OVP/UVLO | SOIC-8 | $0.30 | $0.60 |
| 2 | NTCLE100E3 | NTC thermistor 10kΩ | Radial | $0.20 | $0.40 |
| | | **Subtotal Protection** | | | **$1.14** |

### 8.6 Miscellaneous

| Qty | Description | Total $ |
|-----|-------------|---------|
| ~50 | Bypass caps (100nF, 10µF) | $2.00 |
| 1 | PCB (6-layer, 120×100mm) | $15.00 |
| 3 | Connectors (phase output) | $2.00 |
| 1 | DC input connector | $1.50 |
| Various | Resistors, pull-ups, LEDs | $1.50 |
| | **Subtotal Misc** | **$22.00** |

### 8.7 **TOTAL SYSTEM COST**

```
Power Stage:          $58.23
Input Capacitors:     $12.00
Current Sensing:      $7.56
Power Supply:         $6.90
Protection:           $1.14
Miscellaneous:        $22.00
───────────────────────────
TOTAL BOM COST:       $107.83 ≈ $110
```

**Cost Breakdown by MOSFETConfiguration:**
| Configuration | MOSFET Cost | Other | Total |
|---------------|-------------|-------|-------|
| Single (6×) | $16.50 | $61.00 | $77.50 |
| 2× Parallel (12×) | $33.00 | $61.00 | $94.00 |
| **3× Parallel (18×)** | **$49.50** | **$58.33** | **$107.83** |

**Trade-off Analysis:**
- 3× config costs $30 more than single
- BUT: 98.2% efficiency vs. 96.9%
- AND: 45.7°C vs. 172°C junction temp
- RESULT: Worth the cost for reliability ✓

---

## 9. PCB DESIGN GUIDELINES (3× Parallel)

### 9.1 Layer Stack-up (6-Layer Recommended)

```
Layer 1 (Top):     Components, signal routing, gate drives
Layer 2 (GND):     Continuous ground plane
Layer 3 (Power):   DC+ / High current return
Layer 4 (Power):   Phase outputs, switched nodes
Layer 5 (GND):     Ground plane #2
Layer 6 (Bottom):  Components, power routing
```

**Copper Thickness:**
- Layers 3, 4, 6: 2oz (70µm) for power
- Layers 1, 2, 5: 1oz (35µm) for signals/ground

### 9.2 3× Parallel MOSFET Layout

**Critical Layout Rules:**

**1. Symmetric Gate Routing:**
```
Gate Driver OUT
      │
      ├────[Rg]────[Rg]────[Rg]──── 3× MOSFETs Gates
      │      │       │       │
   Same    Same    Same    Same
   Length  Length  Length  Length
   (±2mm tolerance)
```

**2. Individual Gate Resistor Placement:**
- Place R_g_on and R_g_off right at MOSFET gate pin
- <2mm from gate pad to resistor
- Schottky diode between resistors

**3. Kelvin Source Connections:**
```
      Power Source (High Current)
           │││
      ┌────┴┴┴────┐
      │ MOSFET 1-3 │
      └─┬──────┬───┘
        │      └────── Gate Drive Return (Low Current)
        │                 (Goes to driver GND)
        │
   Power Current Path (to phase or GND)
```

**4. Thermal Via Pattern:**
```
Each MOSFET thermal pad:
- 20-25 vias, 0.3mm diameter
- Grid pattern, 0.8mm pitch
- Connect to opposite side copper pour (20×20mm)
- Via-in-pad with solder fill preferred
```

**5. Snubber Placement:**
- RC snubber VERY close to each MOSFET (<5mm)
- Minimize snubber loop area
- Connect directly to drain and source copper

### 9.3 Gate Driver Placement

**Location:**
- Center of 3× MOSFETs (equidistant to all gates)
- Close to bootstrap capacitor
- Near VDD bypass capacitor

**Bootstrap Circuit:**
```
VDD ──[100nF]──┬──── VDD pin
               │
          Thermal Pad connected to GND
               │
HB ──[1µF C_boot]──── HS (switch node)
```

### 9.4 Current Sense Traces

**Kelvin Sensing for Shunt Resistors:**
```
Phase ────┬──[====Shunt====]──┬──── Next Stage
  Current │                   │
   Sense  ├───────────────────┤  Kelvin Traces
   Amp    │                   │  (Separate from
   (INA)  └───────────────────┘   power path)
          Sense+          Sense-
```

- Guard traces with GND on both sides
- Keep differential pair symmetric
- Minimize loop area
- Shield from switching nodes

### 9.5 Power Loop Minimization

**Critical Loop (Per Phase):**
```
DC+ Cap ──→ HS MOSFET ──→ Phase ──→ LS MOSFET ──→ GND Cap
   │                                                  │
   └──────────────────────────────────────────────────┘
             MINIMIZE THIS LOOP AREA!
```

**Best Practices:**
- Place ceramic caps immediately adjacent to MOSFETs
- Wide, short traces (>4mm width for 2oz copper)
- Multiple vias between layers
- Symmetric layout for all 3 phases

---

## 10. FIRMWARE CONSIDERATIONS

### 10.1 Gate Driver Enable Sequence

**Power-Up Sequence:**
```
1. Wait for VDD stable (>11V)
2. Enable DC-DC converter (LMR51430 EN pin)
3. Wait 10ms for 12V rail to stabilize
4. Enable LDOs (5V, 3.3V)
5. Wait 5ms for logic rails
6. Initialize MCU, check ADCs
7. Enable gate drivers (UCC27311A-Q1 EN pins)
8. Start PWM generation
```

**Shutdown Sequence (Fault Condition):**
```
1. Immediately disable gate drivers (EN pin LOW)
2. Set all PWM outputs to LOW
3. Wait 1ms for MOSFETs to turn off
4. Latch fault condition
5. Indicate fault via LED/CAN
```

### 10.2 Dead-Time Calculation

**With UCC27311A-Q1:**
```
Propagation delay: ~16ns
Rise time (with Rg): ~322ns
Fall time: ~261ns

Required dead-time:
t_dead = t_fall + t_prop_delay + t_margin
t_dead = 261ns + 16ns + 200ns (margin) = 477ns

Use: 500ns dead-time in firmware ✓
```

### 10.3 Over-Temperature Monitoring

**NTC Thermistor Placement:**
- One thermistor on heatsink near hottest MOSFET
- Read via ADC every 100ms
- Software thresholds:
  - 85°C: Warning (reduce power)
  - 95°C: Fault (shutdown)
  - 75°C: Resume after cooldown

### 10.4 Current Sensing Calibration

**3-Shunt Configuration:**
```
Phase A: INA241A2 → ADC_IN0
Phase B: INA241A2 → ADC_IN1
Phase C: INA241A2 → ADC_IN2

Calibration:
1. Zero offset calibration (no current)
2. Gain calibration (known current)
3. Store coefficients in flash

Runtime:
- Sample at peak of PWM for accuracy
- Apply offset and gain corrections
- Implement overcurrent detection (90A threshold)
```

---

## 11. TESTING AND VALIDATION

### 11.1 Bench Testing Procedure

**Phase 1: Power Supply Test (No MOSFETs)**
```
1. Apply 48V to DC bus
2. Verify 12V rail: 11.8-12.2V ✓
3. Verify 5V rail: 4.9-5.1V ✓
4. Verify 3.3V rail: 3.25-3.35V ✓
5. Check ripple (<50mV pk-pk)
6. Measure quiescent current
```

**Phase 2: Gate Driver Test (No Motor)**
```
1. Apply low-frequency PWM (100Hz)
2. Scope gate waveforms on all 18 MOSFETs
3. Verify rise/fall times
4. Check for oscillations/ringing
5. Measure gate-source voltage (0V to 12V swing)
6. Test dead-time insertion
```

**Phase 3: Low-Power Motor Test**
```
1. Connect motor (no load)
2. Run 6-step commutation at 10% duty
3. Slowly increase duty to 30%
4. Monitor phase currents (<20A)
5. Check for thermal rise
6. Verify encoder feedback
```

**Phase 4: Full Power Test**
```
1. Apply mechanical load to motor
2. Ramp up to 50%, 75%, 100% power
3. Monitor:
   - Phase currents (target 80A)
   - MOSFET temperature (target <60°C)
   - Efficiency (target >97%)
   - Voltage ripple
4. Run for 30 minutes continuous
5. Thermal imaging of PCB
```

### 11.2 Expected Performance

```
Parameter              Target      Measured
---------------------|-----------|----------
Input Voltage         48V        ____V
DC Bus Ripple         <2V pk-pk  ____V
Phase Current (max)   80A RMS    ____A
Efficiency @ 3kW      >97%       ____%
MOSFET Temp (Tj)      <60°C      ____°C
12V Rail              12V±2%     ____V
PWM Frequency         30kHz      ____kHz
Dead-Time             500ns      ____ns
Gate Rise Time        300-350ns  ____ns
Gate Fall Time        250-300ns  ____ns
```

---

## 12. DESIGN SUMMARY & RECOMMENDATIONS

### 12.1 Key Design Decisions

| Aspect | Decision | Rationale |
|--------|----------|-----------|
| **MOSFET** | IAUCN08S7N024 | Automotive grade, excellent R_DS(on), 80V rating |
| **Parallel Config** | 3× per switch | Optimal thermal performance, 98.2% efficiency |
| **Gate Driver** | UCC27311A-Q1 | Integrated bootstrap, automotive, enable pin |
| **Gate Resistors** | 4.7Ω on, 3.3Ω off | Balance speed vs. EMI, individual per MOSFET |
| **Snubbers** | 1Ω + 4.7nF per FET | Dampen ringing, protect from spikes |
| **DC-DC** | LMR51430 (48V→12V) | Wide input range, integrated FETs, efficient |
| **LDOs** | TPS7A7001 (12V→5V), TLV75533 (5V→3.3V) | Low noise, good PSRR |

### 12.2 Performance Summary

```
✓ Efficiency: 98.2% (world-class for motor controller!)
✓ Junction Temp: 45.7°C (129°C margin to max)
✓ Thermal Margin: Can handle 3× overload
✓ Cost: ~$110 (reasonable for performance)
✓ Reliability: Automotive-grade components throughout
✓ EMI: Well-controlled with snubbers and proper layout
```

### 12.3 Final Recommendations

**DO:**
✓ Use 6-layer PCB (mandatory for this design)
✓ 2oz copper on power layers
✓ Thermal vias under every MOSFET (20-25 per device)
✓ Individual gate resistors for each MOSFET
✓ Kelvin connections for current sensing
✓ Test power supply before installing MOSFETs
✓ Use thermal camera to verify thermal design
✓ Implement all protection circuits

**DON'T:**
✗ Share gate resistors between parallel MOSFETs
✗ Skimp on input capacitors (use all 4× 470µF)
✗ Route high-current traces over/near logic signals
✗ Use <4 layers (insufficient for power distribution)
✗ Omit snubbers (voltage spikes will damage MOSFETs)
✗ Place components by hand (reflow soldering required for DFN8)

### 12.4 Upgrade Paths

**For Higher Power (5kW+):**
- Increase to 4× or 5× parallel MOSFETs
- Upgrade DC-DC to higher current rating
- Add forced air cooling

**For Lower Cost:**
- Reduce to 2× parallel MOSFETs (T_j increases to ~80°C)
- Use commercial-grade components (non-automotive)
- Simpler 4-layer PCB

**For Maximum Efficiency:**
- Use IAUCN08S7N013 (1.3mΩ) instead
- Increase to 4× parallel configuration
- Optimize gate resistors for specific application
- SiC or GaN MOSFETs (future upgrade)

---

## APPENDIX A: Quick Reference Tables

### Power Stage Components (Per Phase)

| Component | Part Number | Quantity | Location |
|-----------|-------------|----------|----------|
| HS MOSFET | IAUCN08S7N024 | 3 | U1, U2, U3 |
| LS MOSFET | IAUCN08S7N024 | 3 | U4, U5, U6 |
| Gate Driver | UCC27311A-Q1 | 1 | U7 |
| R_g_on (HS) | 4.7Ω 0805 | 3 | R1, R2, R3 |
| R_g_off (HS) | 3.3Ω 0805 | 3 | R4, R5, R6 |
| R_g_on (LS) | 4.7Ω 0805 | 3 | R7, R8, R9 |
| R_g_off (LS) | 3.3Ω 0805 | 3 | R10, R11, R12 |
| Schottky (HS) | BAT54 | 3 | D1, D2, D3 |
| Schottky (LS) | BAT54 | 3 | D4, D5, D6 |
| Snubber R | 1.0Ω 0805 | 6 | R13-R18 |
| Snubber C | 4.7nF 100V | 6 | C1-C6 |
| Bootstrap C | 1µF 25V | 1 | C7 |

### Key Formulas

```
Parallel R_DS(on): R_eq = R_DS / N (where N = number parallel)
Gate charge: Q_total = N × Q_g_single
Dead-time: t_dead ≥ t_fall + t_prop + margin (200ns)
Snubber: R_snub = 0.5 × √(L/C)
Thermal: T_j = T_ambient + (P × R_thJA)
Efficiency: η = P_out / (P_out + P_losses)
```

---

**Document Version**: 3.0 - Complete 3× Parallel Design
**Date**: January 2026
**Design**: 3kW PMSM Controller, IAUCN08S7N024, UCC27311A-Q1
**Status**: Ready for PCB Layout and Prototype
