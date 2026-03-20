"""SPICE Netlist Generator for Motor Controller Half-Bridge

Generates an ngspice-compatible .cir netlist from calculated component values.
Exports a single half-bridge leg with gate drive circuit, bootstrap, snubber,
bus capacitors, and current shunt — ready for transient simulation.
"""
import textwrap
from datetime import datetime


def generate_spice_netlist(system_specs: dict, calculations: dict, mosfet_params: dict) -> str:
    """Generate a SPICE netlist string from calculation results.

    Args:
        system_specs: System-level specs (bus_voltage, peak_voltage, etc.)
        calculations: Output from CalculationEngine.run_all()
        mosfet_params: Raw MOSFET parameters (flat dict with __unit keys)

    Returns:
        String containing ngspice-compatible netlist (.cir format)
    """
    # Extract system specs
    v_bus = system_specs.get('bus_voltage', 48)
    v_peak = system_specs.get('peak_voltage', 60)
    i_max = system_specs.get('max_phase_current', 80)
    fsw = system_specs.get('pwm_freq_hz', 20000)
    v_drv = system_specs.get('gate_drive_voltage', 12)

    # Extract from calculations
    gr = calculations.get('gate_resistors', {})
    bs = calculations.get('bootstrap_cap', {})
    sn = calculations.get('snubber', {})
    ic = calculations.get('input_capacitors', {})
    sh = calculations.get('shunt_resistors', {})
    dt = calculations.get('dead_time', {})

    rg_on = gr.get('rg_on_recommended_ohm', 4.7)
    rg_off = gr.get('rg_off_recommended_ohm', 2.2)
    c_boot_nf = bs.get('c_boot_recommended_nf', 220)
    rs_snub = sn.get('rs_recommended_ohm', 10)
    cs_snub_pf = sn.get('cs_recommended_pf', 1500)
    n_bulk = ic.get('n_bulk_caps', 4)
    c_bulk_uf = ic.get('c_per_bulk_cap_uf', 100)
    esr_mohm = ic.get('esr_budget_per_cap_mohm', 50)

    # Shunt
    r_shunt_mohm = 1.0  # default
    if sh.get('single_shunt'):
        r_shunt_mohm = sh['single_shunt'].get('value_mohm', 1.0)
    elif sh.get('three_phase_shunt'):
        r_shunt_mohm = sh['three_phase_shunt'].get('value_mohm', 1.0)

    dt_ns = dt.get('dt_actual_ns', 200)
    t_period = 1.0 / fsw
    t_period_us = t_period * 1e6
    dt_us = dt_ns / 1000

    # MOSFET model params (extract from raw params)
    rds_on = _get_mosfet_val(mosfet_params, 'rds_on', 1.5e-3)
    vgs_th = _get_mosfet_val(mosfet_params, 'vgs_th', 3.0)
    vds_max = _get_mosfet_val(mosfet_params, 'vds_max', 100.0)
    coss_pf = _get_mosfet_val(mosfet_params, 'coss', 500e-12) * 1e12
    qg_nc = _get_mosfet_val(mosfet_params, 'qg', 92e-9) * 1e9
    body_diode_vf = _get_mosfet_val(mosfet_params, 'body_diode_vf', 1.0)

    # Motor parameters (use actual values if available)
    motor_rph_mohm = system_specs.get('motor_rph_mohm', 50)
    motor_lph_uh = system_specs.get('motor_lph_uh', 100)

    # Total bus cap (parallel caps)
    c_bus_total_uf = n_bulk * c_bulk_uf
    esr_total_mohm = esr_mohm / n_bulk

    timestamp = datetime.now().strftime('%Y-%m-%d %H:%M')

    # Compute simulation parameters — keep lightweight for browser-based simulators
    # 3 cycles with 10ns step = manageable data points (< 20k rows)
    n_cycles = 3
    t_step_ns = 10
    t_total_us = n_cycles * t_period_us
    t_meas_from_us = 1 * t_period_us  # measure from 2nd cycle onward
    r_shunt_si = r_shunt_mohm * 1e-3  # for .meas expressions

    netlist = f"""\
* =====================================================================
* MC Hardware Designer -- SPICE Netlist Export
* Generated: {timestamp}
* =====================================================================
*
* Topology: Single half-bridge leg (high-side + low-side N-ch MOSFET)
* Bus Voltage: {v_bus}V (peak {v_peak}V)
* Max Phase Current: {i_max}A
* Switching Freq: {fsw/1000:.1f} kHz
* Gate Drive: {v_drv}V
* Dead Time: {dt_ns:.0f} ns
*
* NOTE: This is a simplified behavioral model for design verification.
* Replace MOSFET models with vendor SPICE models for accurate results.
*
* Compatible with: ngspice, LTspice, browser-based SPICE simulators
*

.title MC Half-Bridge {v_bus}V {i_max}A {fsw/1000:.0f}kHz

* -- Options ---------------------------------------------------------
.option RELTOL=0.003
.option ABSTOL=1e-10
.option VNTOL=1e-5
.option ITL4=100

* =====================================================================
* POWER SUPPLY
* =====================================================================
V_BUS   vbus    gnd     DC {v_bus}
V_DRV   vdrv    gnd     DC {v_drv}

* -- Bus Capacitor Bank ({n_bulk}x {c_bulk_uf}uF) --------------------
* Modeled as single equivalent: {c_bus_total_uf}uF + {esr_total_mohm:.1f}mohm ESR
C_BUS   vbus    n_esr   {c_bus_total_uf}u IC={v_bus}
R_ESR   n_esr   gnd     {esr_total_mohm}m

* =====================================================================
* MOSFET MODELS (Behavioral -- replace with vendor models)
* =====================================================================
* Level-1 NMOS: Rds(on)={rds_on*1000:.1f}mohm, Vth={vgs_th:.1f}V, Coss={coss_pf:.0f}pF
.model NMOS_PWR NMOS (LEVEL=1 VTO={vgs_th} KP=200 RD={rds_on/2:.4f} RS={rds_on/2:.4f}
+ CBD={coss_pf}p CBS={coss_pf/2:.0f}p CGDO={qg_nc/v_drv:.2f}n CGSO={qg_nc/v_drv:.2f}n
+ IS=1e-14 TOX=100n)

* Body diode model (BV = MOSFET Vds_max)
.model DBODY D (IS=1e-12 RS=0.01 BV={vds_max:.0f} N=1.3 TT=50n VJ={body_diode_vf:.2f})

* -- High-Side MOSFET ------------------------------------------------
M_HS    vbus    g_hs    sw_node sw_node NMOS_PWR W=100m L=1u
D_HS    sw_node vbus    DBODY

* -- Low-Side MOSFET -------------------------------------------------
M_LS    sw_node g_ls    n_shunt n_shunt NMOS_PWR W=100m L=1u
D_LS    n_shunt sw_node DBODY

* =====================================================================
* GATE DRIVE CIRCUIT
* =====================================================================
* Gate resistors: Rg_on={rg_on}ohm, Rg_off={rg_off}ohm
* Simplified as single Rg per MOSFET (parallel on/off path)

R_G_HS  drv_hs  g_hs    {rg_on}
R_G_LS  drv_ls  g_ls    {rg_on}

* -- Bootstrap Circuit -----------------------------------------------
* C_boot={c_boot_nf:.0f}nF, Schottky diode (Vf~0.5V)
D_BOOT  vdrv    n_boot  DSCHOTTKY
C_BOOT  n_boot  sw_node {c_boot_nf}n IC={v_drv - 0.5:.1f}
.model DSCHOTTKY D (IS=1e-8 RS=0.1 N=1.05 BV=100)

* =====================================================================
* RC SNUBBER (across low-side MOSFET)
* =====================================================================
* Rs={rs_snub}ohm, Cs={cs_snub_pf}pF -- critically damped
R_SNUB  sw_node n_snub  {rs_snub}
C_SNUB  n_snub  n_shunt {cs_snub_pf}p

* =====================================================================
* CURRENT SHUNT
* =====================================================================
* R_shunt = {r_shunt_mohm}mohm
R_SHUNT n_shunt gnd     {r_shunt_mohm}m

* =====================================================================
* LOAD (Inductive -- motor phase winding equivalent)
* =====================================================================
* RL load: R_phase = {motor_rph_mohm}mohm, L_phase = {motor_lph_uh}uH
R_LOAD  sw_node n_load  {motor_rph_mohm}m
L_LOAD  n_load  gnd     {motor_lph_uh}u IC=0

* =====================================================================
* PWM GATE DRIVE SIGNALS (with dead time)
* =====================================================================
* High-side: PULSE(0 Vdrv delay rise fall on_time period)
* Low-side: complementary with dead time

* HS on after dead time, off before dead time
V_DRV_HS drv_hs sw_node PULSE(0 {v_drv} {dt_us}u 10n 10n {t_period_us/2 - dt_us}u {t_period_us}u)

* LS on during second half with dead time
V_DRV_LS drv_ls gnd     PULSE(0 {v_drv} {t_period_us/2 + dt_us}u 10n 10n {t_period_us/2 - dt_us}u {t_period_us}u)

* =====================================================================
* SIMULATION COMMANDS
* =====================================================================
* Transient: {n_cycles} switching cycles, {t_step_ns}ns max step
.tran {t_step_ns}n {t_total_us:.1f}u UIC

* -- Measurements ----------------------------------------------------
.meas TRAN v_sw_max MAX V(sw_node)
.meas TRAN v_sw_min MIN V(sw_node)
.meas TRAN i_load_avg AVG I(L_LOAD) FROM={t_meas_from_us:.1f}u TO={t_total_us:.1f}u
.meas TRAN v_shunt_max MAX V(n_shunt)

* -- Probe Points ----------------------------------------------------
* Key waveforms to plot:
*   V(sw_node)       -- switching node voltage
*   V(g_hs, sw_node) -- high-side Vgs
*   V(g_ls)          -- low-side Vgs
*   I(L_LOAD)        -- inductor (motor phase) current
*   V(n_shunt)       -- shunt voltage (for current sensing)
*   I(R_SHUNT)       -- phase current through shunt

.end
"""
    return netlist


def _get_mosfet_val(params: dict, key: str, fallback: float) -> float:
    """Extract a MOSFET parameter value, applying basic unit conversion."""
    val = params.get(key)
    if val is None:
        return fallback
    try:
        val = float(val)
    except (TypeError, ValueError):
        return fallback

    unit = str(params.get(f'{key}__unit', '')).strip()

    multipliers = {
        'mΩ': 1e-3, 'mohm': 1e-3, 'milliohm': 1e-3, 'Ω': 1, 'ohm': 1,
        'nC': 1e-9, 'µC': 1e-6, 'pC': 1e-12, 'C': 1,
        'pF': 1e-12, 'nF': 1e-9, 'µF': 1e-6, 'uF': 1e-6, 'F': 1,
        'ns': 1e-9, 'µs': 1e-6, 'ms': 1e-3, 's': 1,
        'V': 1, 'mV': 1e-3,
        'A': 1, 'mA': 1e-3,
        '°C/W': 1, 'C/W': 1, '°C': 1,
    }

    m = multipliers.get(unit, 1)
    return val * m
