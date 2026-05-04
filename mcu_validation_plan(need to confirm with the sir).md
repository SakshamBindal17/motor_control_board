# MCU Validation Module Implementation Plan

This plan details the implementation of the MCU Validation Module (Point 2 of the Phase 4 audit). Currently, some MCU checks are buried inside the generic `cross_validation` array and are not visible in the frontend grid. We will elevate these into a dedicated, rigorous MCU validation pipeline.

## User Review Required

Please review the proposed UI fields and backend calculations. Are there any other MCU parameters you want to validate (e.g., DMA channels, specific timer frequencies)?

## Proposed Changes

### Backend

#### [MODIFY] `backend/calculations/validation.py`
Create a new `calc_mcu_validation()` method in `ValidationMixin`. This will extract and formalize the MCU checks:
1. **PWM Resolution Check**: Calculate `counts_per_period = cpu_freq_max / (2 * fsw)` and `effective_bits = log2(counts_per_period)`. Warn if `< 8` bits.
2. **Complementary Outputs Check**: Verify the MCU has `>= 3` complementary PWM pairs.
3. **ADC Speed Check**: Pull in the ADC sampling rate and check against the required `sampling_window_us` (already calculated in `adc_timing` but we will consolidate the high-level summary here).

#### [MODIFY] `backend/calculations/base.py`
Add `"mcu_validation": self.calc_mcu_validation()` to the `run_all()` method to expose it to the API. Update `CALC_DEPS` in `calc_engine.py` if we add any new dependencies (though `cpu_freq_max`, `pwm_resolution`, and `complementary_outputs` should already be there).

### Frontend

#### [MODIFY] `frontend/src/components/CalculationsPanel.jsx`
Add a new section to the `SECTIONS` array for **MCU Hardware Validation**:
- `cpu_freq_mhz`: MCU Clock Speed
- `pwm_resolution_bits`: Effective PWM Resolution (Bits)
- `complementary_outputs`: Complementary PWM Pairs
- `adc_rate_msps`: ADC Sampling Rate
- `mcu_verdict`: Pass/Fail status for FOC drive

## Verification Plan

### Automated Tests
- Upload an MCU datasheet (or use mock data) and verify the backend API returns the `mcu_validation` object with correct mathematics.

### Manual Verification
- Open the UI and verify the new **MCU Checks** grid section renders correctly.
- Test with a low CPU frequency (e.g., 16MHz) to ensure the PWM resolution triggers a `danger` warning.
- Test with `< 3` complementary outputs to trigger a warning.
