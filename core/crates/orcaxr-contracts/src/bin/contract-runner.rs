use std::io::{self, BufRead, Write};

fn main() -> io::Result<()> {
    let stdin = io::stdin();
    let mut reader = stdin.lock();
    let mut output = io::BufWriter::new(io::stdout().lock());
    // The harness accepts bounded JSON lines; never echo private request data.
    loop {
        let mut line = Vec::new();
        let count = std::io::Read::take(
            &mut reader,
            (orcaxr_contracts::generated::MAX_REQUEST_BYTES + 2) as u64,
        )
        .read_until(b'\n', &mut line)?;
        if count == 0 {
            break;
        }
        if line.len() > orcaxr_contracts::generated::MAX_REQUEST_BYTES + 1 {
            return Err(io::Error::other("request limit"));
        }
        let source = std::str::from_utf8(&line).map_err(|_| io::Error::other("invalid UTF-8"))?;
        writeln!(
            output,
            "{}",
            orcaxr_contracts::evaluate(source.trim_end_matches('\n'))
        )?;
    }
    output.flush()
}
