/**
 * Shared parameter label definitions.
 * Single source of truth — imported by both BlockPanel.jsx and ProjectContext.jsx.
 */

export const PARAM_LABELS = {
  // ── MOSFET essential ────────────────────────────────────────────────────
  vds_max: 'Max Drain-Source Voltage', id_cont: 'Continuous Drain Current',
  rds_on: 'On-Resistance', vgs_th: 'Gate Threshold Voltage',
  qg: 'Total Gate Charge', qgd: 'Gate-Drain (Miller) Charge',
  qgs: 'Gate-Source Charge', qrr: 'Reverse Recovery Charge',
  trr: 'Reverse Recovery Time', coss: 'Output Capacitance',
  td_on: 'Turn-On Delay Time', tr: 'Rise Time',
  td_off: 'Turn-Off Delay Time', tf: 'Fall Time',
  rth_jc: 'Thermal Resistance (J-C)', tj_max: 'Max Junction Temperature',
  body_diode_vf: 'Body Diode Forward Voltage',
  // ── MOSFET good-to-have ─────────────────────────────────────────────────
  vgs_max: 'Max Gate-Source Voltage', id_pulsed: 'Pulsed Drain Current',
  ciss: 'Input Capacitance', crss: 'Reverse Transfer Capacitance',
  avalanche_energy: 'Avalanche Energy', rg_int: 'Internal Gate Resistance',
  vgs_plateau: 'Gate Plateau Voltage', qoss: 'Output Charge (Qoss)',
  // ── Gate Driver essential ────────────────────────────────────────────────
  vcc_range: 'VCC Supply Voltage Range', vcc_uvlo: 'VCC UVLO',
  vbs_max: 'Max Bootstrap Voltage', vbs_uvlo: 'Bootstrap UVLO',
  io_source: 'Peak Source Current', io_sink: 'Peak Sink Current',
  prop_delay_on: 'Prop Delay (Turn-On)', prop_delay_off: 'Prop Delay (Turn-Off)',
  deadtime_min: 'Minimum Dead Time', deadtime_default: 'Default Dead Time',
  vil: 'Input Logic Low (VIL)', vih: 'Input Logic High (VIH)',
  rth_ja: 'Thermal Resistance (J-A)',
  // ── Gate Driver good-to-have ─────────────────────────────────────────────
  ocp_threshold: 'OCP Threshold', ocp_response: 'OCP Blanking Time',
  thermal_shutdown: 'Thermal Shutdown Temp',
  current_sense_gain: 'Current Sense Amplifier Gain',
  rise_time_out: 'Driver Output Rise Time',
  fall_time_out: 'Driver Output Fall Time',
  // ── MCU essential ────────────────────────────────────────────────────────
  cpu_freq_max: 'Max CPU Frequency',
  adc_resolution: 'ADC Resolution', adc_channels: 'ADC Channels',
  adc_sample_rate: 'ADC Sample Rate', adc_ref: 'ADC Reference Voltage',
  pwm_timers: 'Advanced PWM Timers',
  pwm_resolution: 'PWM Timer Resolution',
  pwm_deadtime_res: 'Dead-Time Generator Resolution',
  pwm_deadtime_max: 'Max Programmable Dead Time',
  complementary_outputs: 'Complementary Output Pairs',
  vdd_range: 'VDD Voltage Range',
  // ── MCU good-to-have ────────────────────────────────────────────────────
  flash_size: 'Flash Memory Size', ram_size: 'RAM / SRAM Size',
  spi_count: 'SPI Interfaces', uart_count: 'UART / USART Interfaces',
  idd_run: 'Run Mode Current', temp_range: 'Operating Temperature Range',
  gpio_count: 'Total GPIO Count', encoder_interface: 'Encoder / Hall Interface',
  can_count: 'CAN Bus Interfaces', dma_channels: 'DMA Channels',
}
