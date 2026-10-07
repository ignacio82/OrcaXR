use super::Failure;
use orcaxr_contracts::canonical::Value;
use orcaxr_project::ingress::{
    AssetInputError, ProjectBundleInput,
    json::{JsonInput, JsonInputError, JsonLimits},
};
use std::io::{self, Write};

/// Decode incrementally while stripping exactly one leading UTF-8 BOM, matching
/// TextDecoder. The host's raw byte budget includes that BOM. No complete text
/// or uncompressed envelope buffer is ever retained.
pub(super) struct JsonSink {
    expected: usize,
    limits: JsonLimits,
    prefix: [u8; 3],
    prefix_len: usize,
    input: Option<JsonInput>,
    failure: Option<JsonInputError>,
}
impl JsonSink {
    pub fn new(expected: usize, limits: JsonLimits) -> Result<Self, Failure> {
        // Validate policy before the first ZIP read, even for empty/truncated JSON.
        JsonInput::new(expected, limits).map_err(Failure::Json)?;
        Ok(Self {
            expected,
            limits,
            prefix: [0; 3],
            prefix_len: 0,
            input: None,
            failure: None,
        })
    }
    fn append(&mut self, mut bytes: &[u8]) -> Result<(), JsonInputError> {
        if self.input.is_none() {
            let target = self.expected.min(3);
            let n = bytes.len().min(target - self.prefix_len);
            self.prefix[self.prefix_len..self.prefix_len + n].copy_from_slice(&bytes[..n]);
            self.prefix_len += n;
            bytes = &bytes[n..];
            if self.prefix_len < target {
                return Ok(());
            }
            let bom = self.prefix_len == 3 && self.prefix == [0xef, 0xbb, 0xbf];
            let mut input = JsonInput::new(self.expected - if bom { 3 } else { 0 }, self.limits)?;
            if !bom && self.prefix_len != 0 {
                input.append(0, &self.prefix[..self.prefix_len])?;
            }
            self.input = Some(input);
        }
        let input = self.input.as_mut().unwrap();
        for chunk in bytes.chunks(crate::CHUNK_BYTES) {
            input.append(input.received_bytes(), chunk)?;
        }
        Ok(())
    }
    pub fn failure(&self) -> Option<JsonInputError> {
        self.failure
    }
    pub fn finish(mut self) -> Result<Value, Failure> {
        if let Some(error) = self.failure {
            return Err(Failure::Json(error));
        }
        if self.input.is_none() {
            self.append(&[]).map_err(Failure::Json)?;
        }
        self.input
            .ok_or(Failure::Json(JsonInputError::Incomplete))?
            .finish()
            .map_err(Failure::Json)
    }
}
impl Write for JsonSink {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.failure.is_some() {
            return Err(io::ErrorKind::InvalidData.into());
        }
        if let Err(error) = self.append(bytes) {
            self.failure = Some(error);
            return Err(io::ErrorKind::InvalidData.into());
        }
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
pub(super) struct AssetSink<'a> {
    bundle: &'a mut ProjectBundleInput,
    offset: usize,
    pub failure: Option<AssetInputError>,
}
impl<'a> AssetSink<'a> {
    pub fn new(bundle: &'a mut ProjectBundleInput) -> Self {
        Self {
            bundle,
            offset: 0,
            failure: None,
        }
    }
}
impl Write for AssetSink<'_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.is_empty() {
            return Ok(0);
        }
        if let Err(error) = self.bundle.append_asset(self.offset, bytes) {
            self.failure = Some(error);
            return Err(io::ErrorKind::InvalidData.into());
        }
        self.offset += bytes.len();
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
pub(super) struct CompareSink<'a> {
    bytes: &'a [u8],
    offset: usize,
    pub mismatch: bool,
}
impl<'a> CompareSink<'a> {
    pub fn new(bytes: &'a [u8]) -> Self {
        Self {
            bytes,
            offset: 0,
            mismatch: false,
        }
    }
}
impl Write for CompareSink<'_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > self.bytes.len() - self.offset
            || &self.bytes[self.offset..self.offset + bytes.len()] != bytes
        {
            self.mismatch = true;
            return Err(io::ErrorKind::InvalidData.into());
        }
        self.offset += bytes.len();
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn limits() -> JsonLimits {
        JsonLimits {
            max_bytes: 1 << 20,
            max_nodes: 100,
            max_text_units: 1000,
            max_number_bytes: 100,
            max_depth: 128,
        }
    }
    #[test]
    fn split_bom_utf8_and_escapes_match_text_decoder() {
        for prefix in [b"".as_slice(), &[0xef, 0xbb, 0xbf]] {
            let text = "{\"x\":\"🐳é\\ud800\",\"duplicate\":1,\"duplicate\":2}";
            let bytes = [prefix, text.as_bytes()].concat();
            for split in 0..=bytes.len() {
                let mut sink = JsonSink::new(bytes.len(), limits()).unwrap();
                sink.write_all(&bytes[..split]).unwrap();
                sink.write_all(&bytes[split..]).unwrap();
                assert_eq!(
                    sink.finish().unwrap(),
                    orcaxr_contracts::canonical::parse(text).unwrap()
                );
            }
            let mut sink = JsonSink::new(bytes.len(), limits()).unwrap();
            for byte in &bytes {
                sink.write_all(&[*byte]).unwrap();
            }
            assert_eq!(
                sink.finish().unwrap(),
                orcaxr_contracts::canonical::parse(text).unwrap()
            );
        }
        for bytes in [
            b"".as_slice(),
            &[0xef],
            &[0xef, 0xbb],
            &[0xef, 0xbb, 0xbf],
            &[0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, b'0'],
        ] {
            let mut sink = JsonSink::new(bytes.len(), limits()).unwrap();
            if sink.write_all(bytes).is_ok() {
                assert!(sink.finish().is_err());
            }
        }
        let bytes = [0xef, 0xbb, 0xbf, b'0'];
        let mut budget = limits();
        budget.max_bytes = 3;
        assert!(matches!(
            JsonSink::new(bytes.len(), budget),
            Err(Failure::Json(JsonInputError::Limit))
        ));
    }
}
