//! Parse directory metadata before any member expands. ZIP64 widens integer
//! fields, never resource limits. No entry name is used as a filesystem path.
use crate::{
    Error, MAX_SAFE_INTEGER, Result, ZipLimits, check_cancel,
    read::{Entry, checked_read},
    validate_package_path,
};
use std::{
    collections::BTreeSet,
    io::{Read, Seek, SeekFrom},
};

struct Scan<'a, R, F> {
    source: &'a mut R,
    bytes: u64,
    cancelled: &'a mut F,
}
impl<R: Read + Seek, F: FnMut() -> bool> Scan<'_, R, F> {
    fn get(&mut self, offset: u64, size: usize) -> Result<Vec<u8>> {
        if offset
            .checked_add(size as u64)
            .is_none_or(|end| end > self.bytes)
        {
            return Err(Error::Truncated);
        }
        check_cancel(self.cancelled)?;
        self.source.seek(SeekFrom::Start(offset))?;
        let mut result = vec![0; size];
        checked_read(self.source, &mut result, self.cancelled)?;
        Ok(result)
    }
    fn wide_extra(
        &mut self,
        start: u64,
        length: u64,
        wanted: [bool; 3],
    ) -> Result<[Option<u64>; 3]> {
        let end = start.checked_add(length).ok_or(Error::InvalidDirectory)?;
        if end > self.bytes {
            return Err(Error::Truncated);
        }
        let mut cursor = start;
        while cursor + 4 <= end {
            let header = self.get(cursor, 4)?;
            let size = u16_at(&header, 2) as u64;
            let next = cursor + 4 + size;
            if next > end {
                return Err(Error::InvalidDirectory);
            }
            if u16_at(&header, 0) == 1 {
                let mut field = cursor + 4;
                let mut result = [None; 3];
                for (index, take) in wanted.into_iter().enumerate() {
                    if take {
                        if field + 8 > next {
                            return Err(Error::InvalidDirectory);
                        }
                        result[index] = Some(wide(&self.get(field, 8)?, 0)?);
                        field += 8;
                    }
                }
                return Ok(result);
            }
            cursor = next;
        }
        Err(Error::InvalidDirectory)
    }
    fn end(&mut self, limits: ZipLimits) -> Result<(u64, u64, u64)> {
        if self.bytes < 22 {
            return Err(Error::Truncated);
        }
        let start = self.bytes.saturating_sub(65_557);
        let tail = self.get(start, (self.bytes - start) as usize)?;
        let at = (0..=tail.len() - 22)
            .rev()
            .find(|&i| {
                u32_at(&tail, i) == 0x0605_4b50
                    && i + 22 + u16_at(&tail, i + 20) as usize == tail.len()
            })
            .ok_or(Error::InvalidDirectory)?;
        if u16_at(&tail, at + 4) != 0 || u16_at(&tail, at + 6) != 0 {
            return Err(Error::Unsupported);
        }
        let original = [
            u16_at(&tail, at + 8) as u64,
            u16_at(&tail, at + 10) as u64,
            u32_at(&tail, at + 12) as u64,
            u32_at(&tail, at + 16) as u64,
        ];
        let sentinels = [0xffff, 0xffff, 0xffff_ffff, 0xffff_ffff];
        let mut fields = original;
        let mut directory_end = start + at as u64;
        if original
            .iter()
            .zip(sentinels)
            .any(|(value, sentinel)| *value == sentinel)
        {
            let locator_at = directory_end
                .checked_sub(20)
                .ok_or(Error::InvalidDirectory)?;
            let locator = self.get(locator_at, 20)?;
            if u32_at(&locator, 0) != 0x0706_4b50 {
                return Err(Error::InvalidDirectory);
            }
            if u32_at(&locator, 4) != 0 || u32_at(&locator, 16) != 1 {
                return Err(Error::Unsupported);
            }
            let record_at = wide(&locator, 8)?;
            if record_at + 56 > locator_at {
                return Err(Error::InvalidDirectory);
            }
            let record = self.get(record_at, 56)?;
            let size = wide(&record, 4)?;
            if u32_at(&record, 0) != 0x0606_4b50 || size < 44 || record_at + 12 + size != locator_at
            {
                return Err(Error::InvalidDirectory);
            }
            if u32_at(&record, 16) != 0 || u32_at(&record, 20) != 0 {
                return Err(Error::Unsupported);
            }
            fields = [
                wide(&record, 24)?,
                wide(&record, 32)?,
                wide(&record, 40)?,
                wide(&record, 48)?,
            ];
            for i in 0..4 {
                if original[i] != sentinels[i] && original[i] != fields[i] {
                    return Err(Error::InvalidDirectory);
                }
            }
            directory_end = record_at;
        }
        let [on_disk, count, size, offset] = fields;
        if on_disk != count || offset + size != directory_end || count > size / 46 {
            return Err(Error::InvalidDirectory);
        }
        if count > limits.entries {
            return Err(Error::ResourceLimit);
        }
        Ok((count, offset, directory_end))
    }
}

pub(crate) fn inspect<R: Read + Seek>(
    source: &mut R,
    bytes: u64,
    limits: ZipLimits,
    cancelled: &mut impl FnMut() -> bool,
) -> Result<Vec<Entry>> {
    let mut scan = Scan {
        source,
        bytes,
        cancelled,
    };
    let (count, central, directory_end) = scan.end(limits)?;
    let capacity = usize::try_from(count).map_err(|_| Error::ResourceLimit)?;
    let mut entries = Vec::new();
    entries
        .try_reserve_exact(capacity)
        .map_err(|_| Error::ResourceLimit)?;
    let mut regions = Vec::new();
    regions
        .try_reserve_exact(capacity)
        .map_err(|_| Error::ResourceLimit)?;
    let mut paths = BTreeSet::new();
    let mut offset = central;
    let mut total = 0u64;
    for _ in 0..count {
        if offset + 46 > directory_end {
            return Err(Error::InvalidDirectory);
        }
        let record = scan.get(offset, 46)?;
        if u32_at(&record, 0) != 0x0201_4b50 {
            return Err(Error::InvalidDirectory);
        }
        let flags = u16_at(&record, 8);
        let compression = u16_at(&record, 10);
        if flags & (1 | 0x20 | 0x40 | 0x2000) != 0 || ![0, 8].contains(&compression) {
            return Err(Error::Unsupported);
        }
        let crc = u32_at(&record, 16);
        let mut compressed = u32_at(&record, 20) as u64;
        let mut uncompressed = u32_at(&record, 24) as u64;
        let name_len = u16_at(&record, 28) as usize;
        let extra_len = u16_at(&record, 30) as u64;
        let end = offset + 46 + name_len as u64 + extra_len + u16_at(&record, 32) as u64;
        if end > directory_end {
            return Err(Error::InvalidDirectory);
        }
        if u16_at(&record, 34) != 0 {
            return Err(Error::Unsupported);
        }
        let mut local = u32_at(&record, 42) as u64;
        let wanted = [
            uncompressed == 0xffff_ffff,
            compressed == 0xffff_ffff,
            local == 0xffff_ffff,
        ];
        if wanted.contains(&true) {
            let wide = scan.wide_extra(offset + 46 + name_len as u64, extra_len, wanted)?;
            uncompressed = wide[0].unwrap_or(uncompressed);
            compressed = wide[1].unwrap_or(compressed);
            local = wide[2].unwrap_or(local);
        }
        if local + 30 > central {
            return Err(Error::InvalidDirectory);
        }
        let name = scan.get(offset + 46, name_len)?;
        if flags & 0x800 == 0 && !name.is_ascii() {
            return Err(Error::UnsafePath);
        }
        let decoded = std::str::from_utf8(&name).map_err(|_| Error::UnsafePath)?;
        // A ZIP filename is a byte string, not a standalone text document.
        // Preserve leading U+FEFF so distinct package members never collapse.
        let path = decoded;
        let directory = path.ends_with('/');
        validate_package_path(
            if directory {
                &path[..path.len() - 1]
            } else {
                path
            },
            limits.path_bytes,
        )?;
        let header = scan.get(local, 30)?;
        if u32_at(&header, 0) != 0x0403_4b50 {
            return Err(Error::InvalidDirectory);
        }
        let local_name_len = u16_at(&header, 26) as usize;
        let local_extra_len = u16_at(&header, 28) as u64;
        let data = local + 30 + local_name_len as u64 + local_extra_len;
        if data + compressed > central {
            return Err(Error::InvalidDirectory);
        }
        if flags != u16_at(&header, 6)
            || compression != u16_at(&header, 8)
            || local_name_len != name_len
            || scan.get(local + 30, local_name_len)? != name
        {
            return Err(Error::InvalidDirectory);
        }
        let mut local_compressed = u32_at(&header, 18) as u64;
        let mut local_uncompressed = u32_at(&header, 22) as u64;
        let wanted = [
            local_uncompressed == 0xffff_ffff,
            local_compressed == 0xffff_ffff,
            false,
        ];
        if wanted.contains(&true) {
            let wide =
                scan.wide_extra(local + 30 + local_name_len as u64, local_extra_len, wanted)?;
            local_uncompressed = wide[0].unwrap_or(local_uncompressed);
            local_compressed = wide[1].unwrap_or(local_compressed);
        }
        if flags & 8 == 0
            && (crc != u32_at(&header, 14)
                || local_compressed != compressed
                || local_uncompressed != uncompressed)
        {
            return Err(Error::InvalidDirectory);
        }
        if !paths.insert(path.to_owned()) {
            return Err(Error::DuplicatePath);
        }
        if uncompressed > limits.entry_bytes
            || uncompressed > limits.total_uncompressed_bytes - total
        {
            return Err(Error::ResourceLimit);
        }
        total += uncompressed;
        if uncompressed > 1 << 20
            && uncompressed as f64 / compressed.max(1) as f64 > limits.compression_ratio
        {
            return Err(Error::ResourceLimit);
        }
        if compression == 0 && compressed != uncompressed {
            return Err(Error::SizeMismatch);
        }
        regions.push((local, data + compressed));
        entries.push(Entry {
            path: path.to_owned(),
            compression,
            compressed,
            uncompressed,
            crc,
            data,
            directory,
        });
        offset = end;
    }
    if offset != directory_end {
        return Err(Error::InvalidDirectory);
    }
    regions.sort_unstable();
    if regions.windows(2).any(|w| w[1].0 < w[0].1) {
        return Err(Error::OverlappingEntries);
    }
    check_cancel(scan.cancelled)?;
    Ok(entries)
}
// Only called on fixed records whose full byte length was checked by Scan::get.
fn u16_at(bytes: &[u8], at: usize) -> u16 {
    u16::from_le_bytes(bytes[at..at + 2].try_into().unwrap())
}
fn u32_at(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap())
}
fn wide(bytes: &[u8], at: usize) -> Result<u64> {
    let value = u64::from_le_bytes(bytes[at..at + 8].try_into().unwrap());
    if value > MAX_SAFE_INTEGER {
        Err(Error::ResourceLimit)
    } else {
        Ok(value)
    }
}
