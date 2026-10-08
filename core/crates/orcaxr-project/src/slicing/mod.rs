//! Slice-time checks over immutable canonical captures
//! (`web/src/project/slicing` and the workspace's live profile target), and
//! their host exchange. No engine runs here.
macro_rules! names {
    ($(#[$meta:meta])* $name:ident { $($variant:ident => $text:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub enum $name { $($variant),+ }
        impl $name {
            pub const ALL: &'static [Self] = &[$(Self::$variant),+];
            pub fn as_str(self) -> &'static str {
                match self { $(Self::$variant => $text),+ }
            }
        }
    };
}
pub mod preflight;
pub mod profile;
pub mod report;
