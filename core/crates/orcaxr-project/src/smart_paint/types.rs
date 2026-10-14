//! Smart Paint data types, constraints, and error codes (P4.9).
use serde::{Deserialize, Serialize};

/// Maximum regions accepted in a proposal (P4.9 bounded execution).
pub const AI_PAINT_MAX_REGIONS: usize = 32;

/// Maximum characters in a region's label.
pub const AI_PAINT_MAX_LABEL_LENGTH: usize = 64;

/// Pinned schema version for proposal payloads.
pub const AI_PAINT_PROPOSAL_VERSION: u32 = 1;

/// Supported geometric shapes for assistant proposals.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SmartPaintShape {
    #[serde(rename = "box")]
    Box {
        min: [f64; 3],
        max: [f64; 3],
    },
    #[serde(rename = "direction")]
    Direction {
        axis: [f64; 3],
        #[serde(rename = "maxAngleDeg")]
        max_angle_deg: f64,
    },
}

/// A parsed region proposal.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SmartPaintRegionProposal {
    pub id: String,
    pub label: String,
    pub confidence: f64,
    pub shape: SmartPaintShape,
}

/// The complete validated assistant proposal.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartPaintProposal {
    pub schema_version: u32,
    pub regions: Vec<SmartPaintRegionProposal>,
}

/// A region projected onto concrete source triangles.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SmartPaintResolvedRegion {
    pub id: String,
    pub label: String,
    pub confidence: f64,
    #[serde(rename = "triangleIndices")]
    pub triangle_indices: Vec<u32>,
    pub coverage: f64,
}

/// Result of projecting a proposal onto a volume's mesh.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartPaintProjection {
    pub volume_id: String,
    pub topology_revision: u64,
    pub triangle_count: usize,
    pub regions: Vec<SmartPaintResolvedRegion>,
    pub coverage: f64,
    pub unassigned_triangle_count: usize,
    pub confidence: f64,
}

/// User's destination assignment for a single proposed region.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartPaintRegionAssignment {
    pub region_id: String,
    /// Destination filament ID or state keyword ("enforce", "block", "prefer", "avoid", "true", or None for unpainted).
    pub value: Option<String>,
    #[serde(default)]
    pub excluded_triangles: Vec<u32>,
}

/// Request to commit Smart Paint regions through the project command pipeline.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartPaintApplyRequest {
    pub volume_id: String,
    pub channel: String,
    pub assignments: Vec<SmartPaintRegionAssignment>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SmartPaintErrorCode {
    MalformedProposal,
    UnsupportedVersion,
    EmptyProposal,
    TooManyRegions,
    MalformedRegion,
    DegenerateMesh,
    VolumeNotFound,
    InvalidMesh,
    StaleGuard,
}

impl SmartPaintErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::MalformedProposal => "malformed-proposal",
            Self::UnsupportedVersion => "unsupported-version",
            Self::EmptyProposal => "empty-proposal",
            Self::TooManyRegions => "too-many-regions",
            Self::MalformedRegion => "malformed-region",
            Self::DegenerateMesh => "degenerate-mesh",
            Self::VolumeNotFound => "volume-not-found",
            Self::InvalidMesh => "invalid-mesh",
            Self::StaleGuard => "stale-guard",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SmartPaintProposalError {
    pub code: SmartPaintErrorCode,
    pub message: String,
}

impl SmartPaintProposalError {
    pub fn new(code: SmartPaintErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for SmartPaintProposalError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for SmartPaintProposalError {}
