//! Emit native archives for independent browser/Python reader verification.
use orcaxr_archive::write::{self, Compression, Limits, Member};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io,
    path::PathBuf,
};
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn main() {
    let directory = PathBuf::from(std::env::args_os().nth(1).expect("output directory"));
    fs::create_dir_all(&directory).unwrap();
    let mut results = vec![];
    let mut cases = vec![
        vec![],
        vec![
            ("a.txt".to_owned(), vec![1]),
            ("\u{feff}a.txt".to_owned(), vec![2]),
            ("\u{feff}\u{feff}a.txt".to_owned(), vec![3]),
            ("__proto__".to_owned(), vec![4]),
            ("10".to_owned(), vec![5]),
            ("2".to_owned(), vec![6]),
            ("𐀀.xml".to_owned(), vec![7]),
            ("\u{e000}.txt".to_owned(), vec![8]),
        ],
    ];
    cases.push(
        [
            "png", "JPG", "JPEG", "3mf", "zip", "WEBP", "mp4", "txt", "xml",
        ]
        .iter()
        .map(|extension| (format!("payload.{extension}"), vec![42; 65539]))
        .collect(),
    );
    let mut seed = 0x81f624ffu32;
    for i in 0..32 {
        let length = [0, 1, 65535, 65536, 65537, 262144][i % 6];
        let bytes = (0..length)
            .map(|_| {
                seed ^= seed << 13;
                seed ^= seed >> 17;
                seed ^= seed << 5;
                seed as u8
            })
            .collect();
        cases.push(vec![
            (format!("case-{i}.bin"), bytes),
            (format!("case-{i}.txt"), vec![i as u8; length]),
        ]);
    }
    cases.push(vec![("ratio.txt".into(), vec![0; 2 << 20])]);
    for (ordinal, files) in cases.iter().enumerate() {
        for wide in [false, true] {
            let path = format!("case-{ordinal}-{}.zip", usize::from(wide));
            let mut limits = Limits::default();
            if wide {
                limits.zip.archive_bytes = 1 << 33;
            }
            let members: Vec<_> = files
                .iter()
                .map(|(path, _)| Member {
                    path,
                    compression: Compression::Auto,
                })
                .collect();
            let mut out = File::create(directory.join(&path)).unwrap();
            let receipt = write::archive(
                &mut out,
                &members,
                limits,
                |i, w| {
                    for b in files[i].1.chunks(997) {
                        w.write_all(b)?;
                    }
                    Ok::<_, io::Error>(())
                },
                || false,
            )
            .unwrap();
            let entries: Vec<_> = files.iter().map(|(path, bytes)| serde_json::json!({"path":path,"bytes":bytes.len(),"sha256":hash(bytes)})).collect();
            results.push(serde_json::json!({"path":path,"bytes":receipt.bytes,"entries":entries}));
        }
    }
    for count in [65535, 65536] {
        let path = format!("count-{count}.zip");
        let names: Vec<_> = (0..count).map(|i| format!("member-{i:05}")).collect();
        let members: Vec<_> = names
            .iter()
            .map(|path| Member {
                path,
                compression: Compression::Stored,
            })
            .collect();
        let mut limits = Limits::default();
        limits.zip.entries = 70000;
        let mut out = File::create(directory.join(&path)).unwrap();
        let receipt =
            write::archive(&mut out, &members, limits, |_, _| Ok::<_, ()>(()), || false).unwrap();
        results
            .push(serde_json::json!({"path":path,"bytes":receipt.bytes,"emptyMemberCount":count}));
    }
    fs::write(
        directory.join("manifest.json"),
        serde_json::to_vec_pretty(&results).unwrap(),
    )
    .unwrap();
    println!("Generated {} native ZIP reference archives", results.len());
}
