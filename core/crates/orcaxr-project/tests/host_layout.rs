use orcaxr_project::host_layout::*;
#[test]
fn host_options_preserve_explicit_u32_budgets_and_reject_coercion() {
    let valid = [
        1_000_000.,
        100_000.,
        200_000.,
        1024.,
        128.,
        10.,
        8_388_608.,
        16_777_216.,
        100.,
        33_554_432.,
    ];
    let decoded = decode_options(1., &valid).unwrap();
    assert_eq!(decoded.asset_bytes, 8_388_608);
    assert_eq!(decoded.history_bytes, 33_554_432);
    for version in [0., 2., -1., 1.5, f64::NAN, f64::INFINITY] {
        assert!(decode_options(version, &valid).is_none());
    }
    for field in 0..valid.len() {
        for value in [-1., 0.5, f64::NAN, f64::INFINITY, 4_294_967_296.] {
            let mut bad = valid;
            bad[field] = value;
            assert!(decode_options(1., &bad).is_none());
        }
    }
    for len in [0, 9, 11] {
        assert!(decode_options(1., &vec![1.; len]).is_none());
    }
    let mut exact = valid;
    exact[0] = MAX_BUDGET as f64;
    assert_eq!(
        decode_options(1., &exact).unwrap().document_bytes,
        MAX_BUDGET
    );
    exact[3] = 0.;
    assert!(decode_options(1., &exact).is_none());
    exact = valid;
    exact[4] = 129.;
    assert!(decode_options(1., &exact).is_none());
}
