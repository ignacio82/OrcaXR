use orcaxr_gcode::*;

#[test]
fn source_chunks_are_transactional_and_sealed_sources_are_immutable() {
    let mut session = Session::new(7, "{}", Cancellation::default()).unwrap();
    assert_eq!(session.seal(), Err(SessionError::SourceLength));
    assert_eq!(session.append(1, &[71]), Err(SessionError::SourceLength));
    assert_eq!(session.append(0, &[0; 8]), Err(SessionError::SourceLength));
    session.append(0, &[71, 49, 32]).unwrap();
    session.append(3, &[88, 49, 13, 10]).unwrap();
    let info: serde_json::Value = serde_json::from_str(&session.seal().unwrap()).unwrap();
    assert_eq!(info["recordCount"], 1);
    assert_eq!(info["limits"]["records"], 240_000);
    assert_eq!(session.append(7, &[]), Err(SessionError::InvalidState));
    assert_eq!(session.seal(), Err(SessionError::InvalidState));
    assert_eq!(session.window(1, 0), Err(SessionError::InvalidRange));
    assert_eq!(
        session.window(0, usize::MAX),
        Err(SessionError::InvalidRange)
    );
    assert_eq!(session.page(0, 257), Err(SessionError::InvalidRange));
    let packet = session.whole().unwrap();
    assert_eq!(&packet[..4], b"OXGP");
    assert_eq!(u32::from_le_bytes(packet[12..16].try_into().unwrap()), 1);
    assert_eq!(
        u32::from_le_bytes(packet[20..24].try_into().unwrap()) as usize,
        packet.len()
    );
    assert!(packet.capacity() <= layout::MAX_PACKET_BYTES);
}

#[test]
fn session_refuses_resource_expansion_and_cancelled_results() {
    assert!(matches!(
        Session::new(
            Limits::default().input_characters + 1,
            "{}",
            Cancellation::default()
        ),
        Err(SessionError::ResourceLimit)
    ));
    for options in [
        "[]",
        "{\"limits\":[]}",
        "null",
        "{\"unknown\":1}",
        "{\"limits\":{\"records\":0}}",
        "{\"filamentDiametersMm\":[-1]}",
    ] {
        assert!(matches!(
            Session::new(0, options, Cancellation::default()),
            Err(SessionError::InvalidOptions)
        ));
    }
    let cancellation = Cancellation::default();
    let mut session = Session::new(0, "{}", cancellation.clone()).unwrap();
    session.seal().unwrap();
    cancellation.cancel();
    assert_eq!(session.whole(), Err(SessionError::Cancelled));
    assert_eq!(session.window(0, 0), Err(SessionError::Cancelled));
    assert_eq!(session.info(), Err(SessionError::Cancelled));
}

#[test]
fn packing_checks_column_lengths_before_allocating_the_packet() {
    let mut model = parse(
        &"G1 X1".encode_utf16().collect::<Vec<_>>(),
        &Options::default(),
    )
    .unwrap();
    model.columns.start_x.push(123.0);
    assert_eq!(pack(&model), Err(SessionError::InvalidState));
    model.columns.start_x.pop();
    model.path_points.count = 1;
    assert_eq!(pack(&model), Err(SessionError::InvalidState));
}

#[test]
fn packing_cooperatively_cancels_without_returning_a_partial_transfer() {
    use std::{
        sync::{Arc, Barrier},
        time::{Duration, Instant},
    };
    let source = format!("G91\n{}", "G1 X1\n".repeat(240_000))
        .encode_utf16()
        .collect::<Vec<_>>();
    let model = parse(&source, &Options::default()).unwrap();
    assert_eq!(model.columns.count, 240_000);
    let cancellation = Cancellation::default();
    let token = cancellation.clone();
    let entered = Arc::new(Barrier::new(2));
    let start = entered.clone();
    let worker = std::thread::spawn(move || {
        start.wait();
        loop {
            match pack_with_cancellation(&model, &token) {
                Ok(packet) => assert!(packet.len() > 20_000_000),
                Err(error) => return error,
            }
        }
    });
    entered.wait();
    std::thread::sleep(Duration::from_millis(3));
    let start = Instant::now();
    cancellation.cancel();
    assert_eq!(worker.join().unwrap(), SessionError::Cancelled);
    assert!(
        start.elapsed() < Duration::from_secs(5),
        "packing cancellation watchdog"
    );
}
