//! Lossless schema-1 project candidates. Decoding proves typed structure, stable
//! IDs and finite JSON, not cross-references, topology, settings, timestamps or
//! command eligibility. validation::ValidatedProject proves graph semantics;
//! the store owns revisions and the command bus owns history/rollback policy.
//! The session owns operation identity and its prepared queue; hosts own dispatch.
//! Records preserve unknown fields; clones share immutable child collections,
//! configurations and annotation payloads. Public serialization deliberately
//! makes an owned copy; canonical writing streams directly to a caller's sink.
mod codec;
mod document;
pub(crate) mod equality;
use crate::ids::*;
pub use codec::{
    Decode, Encode, ExtraFields, Json, JsonObject, Number, PathPart, ShapeError, ShapeErrorCode,
    Text,
};
pub use document::*;
use orcaxr_contracts::canonical::Value;
use std::collections::BTreeMap;
use std::io::{self, Write};
use std::marker::PhantomData;
use std::sync::Arc;
pub type List<T> = Arc<[T]>;
pub type ConfigMap = JsonObject;
pub type Vec3 = [Number; 3];
pub type Quaternion = [Number; 4];

macro_rules! record {
    ($name:ident { $($field:ident => $wire:literal : $kind:ty),* $(,)? }) => {
        #[derive(Debug,Clone,PartialEq)]
        pub struct $name {$(pub $field:$kind,)* pub extra:ExtraFields}
        impl $name {pub const FIELDS:&'static[&'static str]=&[$($wire),*]; pub fn field_optionality()->Vec<(&'static str,bool)>{vec![$(($wire,<$kind as Decode>::missing().is_ok())),*]}}
        impl Decode for $name {
            fn from_value(value:Value)->Result<Self,ShapeError>{
                let Value::Object(mut fields)=value else{return Err(ShapeError::new(ShapeErrorCode::ExpectedObject))};
                Ok(Self{$($field:codec::take(&mut fields,$wire)?,)*extra:ExtraFields::decode(fields)?})
            }
        }
        impl Encode for $name {
            fn matches_value(&self, value: &Value) -> io::Result<bool> {
                codec::record_matches(codec::record_fields([$ (($wire,&self.$field as &dyn Encode)),*],&self.extra)?, value)
            }
            fn write_json(&self,out:&mut dyn Write)->io::Result<()>{codec::write_record(codec::record_fields([$ (($wire,&self.$field as &dyn Encode)),*],&self.extra)?,out)}
            fn to_value(&self)->io::Result<Value>{codec::record_value(codec::record_fields([$ (($wire,&self.$field as &dyn Encode)),*],&self.extra)?)}
        }
    };
}
macro_rules! text_enum {
    ($name:ident {$($variant:ident => $wire:literal),+ $(,)?}) => {
        #[derive(Debug,Clone,Copy,PartialEq,Eq)] pub enum $name {$($variant),+}
        impl $name {pub const VALUES:&'static[Self]=&[$(Self::$variant),+];pub fn as_str(self)->&'static str{match self{$(Self::$variant=>$wire),+}}}
        impl Decode for $name {fn from_value(value:Value)->Result<Self,ShapeError>{let Value::String(units)=value else{return Err(ShapeError::new(ShapeErrorCode::ExpectedText))};$(if units.iter().copied().eq($wire.encode_utf16()){return Ok(Self::$variant);})+ Err(ShapeError::new(ShapeErrorCode::InvalidLiteral))}}
        impl Encode for $name {fn write_json(&self,mut out:&mut dyn Write)->io::Result<()>{orcaxr_contracts::canonical::write_string(&self.as_str().encode_utf16().collect::<Vec<_>>(),&mut out)}fn to_value(&self)->io::Result<Value>{Ok(Value::String(self.as_str().encode_utf16().collect()))}}
    };
}
macro_rules! number_enum {
    ($name:ident {$($variant:ident => $wire:literal),+ $(,)?}) => {
        #[derive(Debug,Clone,Copy,PartialEq,Eq)]pub enum $name{$($variant),+}
        impl $name{pub const VALUES:&'static[Self]=&[$(Self::$variant),+];pub fn number(self)->f64{match self{$(Self::$variant=>$wire as f64),+}}}
        impl Decode for $name{fn from_value(value:Value)->Result<Self,ShapeError>{let value=Number::from_value(value)?.get();$(if value==$wire as f64{return Ok(Self::$variant);})+ Err(ShapeError::new(ShapeErrorCode::InvalidLiteral))}}
        impl Encode for $name{fn write_json(&self,mut out:&mut dyn Write)->io::Result<()>{Value::Number(self.number()).write_canonical(&mut out)}fn to_value(&self)->io::Result<Value>{Ok(Value::Number(self.number()))}}
    };
}
macro_rules! bool_literal {
    ($name:ident,$value:literal) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
        pub struct $name;
        impl Decode for $name {
            fn from_value(value: Value) -> Result<Self, ShapeError> {
                if bool::from_value(value)? == $value {
                    Ok(Self)
                } else {
                    Err(ShapeError::new(ShapeErrorCode::InvalidLiteral))
                }
            }
        }
        impl Encode for $name {
            fn write_json(&self, out: &mut dyn Write) -> io::Result<()> {
                $value.write_json(out)
            }
            fn to_value(&self) -> io::Result<Value> {
                Ok(Value::Bool($value))
            }
        }
    };
}
number_enum!(SchemaVersion { One => 1 });
number_enum!(ComponentCount { One=>1,Two=>2,Three=>3,Four=>4 });
number_enum!(FullSpectrumUiMode { Unknown=>-1,Ratio=>0,Cycle=>1,Match=>2,Gradient=>3 });
number_enum!(DistributionMode { LayerCycle=>0,Simple=>2 });
bool_literal!(Disabled, false);
bool_literal!(Enabled, true);
text_enum!(MeshComponentType { Float32=>"float32",Uint16=>"uint16",Uint32=>"uint32" });
text_enum!(SourceAssetKind { Mesh=>"mesh",Archive=>"archive",Thumbnail=>"thumbnail",Extension=>"extension" });
text_enum!(AssetOrigin { Import=>"import",Generated=>"generated",Recovered=>"recovered" });
text_enum!(VolumeRole { Model=>"model",ParameterModifier=>"parameter-modifier",NegativeVolume=>"negative-volume",SupportEnforcer=>"support-enforcer",SupportBlocker=>"support-blocker" });
text_enum!(SupportPaint { Enforce=>"enforce",Block=>"block" });
text_enum!(SeamPaint { Prefer=>"prefer",Avoid=>"avoid" });
text_enum!(EmbossHorizontalAlign { Left=>"left",Center=>"center",Right=>"right" });
text_enum!(EmbossVerticalAlign { Top=>"top",Center=>"center",Bottom=>"bottom" });
text_enum!(LayerEventType { ColorChange=>"color-change",Pause=>"pause",ToolChange=>"tool-change",Template=>"template",Custom=>"custom" });
text_enum!(GcodeScope { Project=>"project",Plate=>"plate" });
text_enum!(GcodeTrigger { BeforePlate=>"before-plate",AfterPlate=>"after-plate",BeforeLayer=>"before-layer",AfterLayer=>"after-layer",ToolChange=>"tool-change" });

record!(Transform {translation_mm=>"translationMm":Vec3,rotation=>"rotation":Quaternion,scale=>"scale":Vec3});
record!(BufferViewDescriptor {byte_offset=>"byteOffset":Number,byte_length=>"byteLength":Number,component_type=>"componentType":MeshComponentType,component_count=>"componentCount":ComponentCount,count=>"count":Number,byte_stride=>"byteStride":Option<Number>});
record!(IndexedMeshDescriptor {positions=>"positions":BufferViewDescriptor,indices=>"indices":Option<BufferViewDescriptor>,triangle_count=>"triangleCount":Number});
record!(AssetProvenance {source=>"source":AssetOrigin,uri=>"uri":Option<Text>,imported_at=>"importedAt":Option<Text>});
record!(SourceAssetDescriptor {id=>"id":AssetId,kind=>"kind":SourceAssetKind,digest=>"digest":Text,byte_length=>"byteLength":Number,media_type=>"mediaType":Text,source_filename=>"sourceFilename":Option<Text>,provenance=>"provenance":Option<Arc<AssetProvenance>>,mesh=>"mesh":Option<Arc<IndexedMeshDescriptor>>});
record!(MeshSourceRef {asset_id=>"assetId":AssetId,topology_revision=>"topologyRevision":Number,triangle_count=>"triangleCount":Number});

/// Sparse assignment payloads retain their original grouping/order and unknown
/// fields. Keep one shared canonical allocation instead of decoding every index
/// into a second graph. The facet validator borrows this exact Value directly.
#[derive(Debug, Clone, PartialEq)]
pub struct Assignments<T> {
    json: Json,
    kind: PhantomData<T>,
}
impl<T> Assignments<T> {
    pub fn value(&self) -> &Value {
        self.json.value()
    }
    pub fn same_allocation(&self, other: &Self) -> bool {
        self.json.same_allocation(&other.json)
    }
}
impl<T: Decode> Decode for Assignments<T> {
    fn from_value(value: Value) -> Result<Self, ShapeError> {
        let Value::Array(entries) = &value else {
            return Err(ShapeError::new(ShapeErrorCode::ExpectedArray));
        };
        for (i, entry) in entries.iter().enumerate() {
            let result = (|| {
                let Value::Object(fields) = entry else {
                    return Err(ShapeError::new(ShapeErrorCode::ExpectedObject));
                };
                let value = fields
                    .get(&"value".encode_utf16().collect::<Vec<_>>())
                    .ok_or_else(|| {
                        ShapeError::new(ShapeErrorCode::MissingField).at(PathPart::Field("value"))
                    })?;
                T::from_value(value.clone()).map_err(|e| e.at(PathPart::Field("value")))?;
                let triangles = fields
                    .get(&"triangles".encode_utf16().collect::<Vec<_>>())
                    .ok_or_else(|| {
                        ShapeError::new(ShapeErrorCode::MissingField)
                            .at(PathPart::Field("triangles"))
                    })?;
                let Value::Array(triangles) = triangles else {
                    return Err(ShapeError::new(ShapeErrorCode::ExpectedArray)
                        .at(PathPart::Field("triangles")));
                };
                for (j, triangle) in triangles.iter().enumerate() {
                    if !matches!(triangle, Value::Number(_)) {
                        return Err(ShapeError::new(ShapeErrorCode::ExpectedNumber)
                            .at(PathPart::Index(j))
                            .at(PathPart::Field("triangles")));
                    }
                }
                Ok(())
            })();
            result.map_err(|e: ShapeError| e.at(PathPart::Index(i)))?;
        }
        Ok(Self {
            json: Json::new(value)?,
            kind: PhantomData,
        })
    }
}
impl<T> Encode for Assignments<T> {
    fn matches_value(&self, value: &Value) -> io::Result<bool> {
        self.json.matches_value(value)
    }
    fn write_json(&self, out: &mut dyn Write) -> io::Result<()> {
        self.json.write_json(out)
    }
    fn to_value(&self) -> io::Result<Value> {
        self.json.to_value()
    }
}
record!(FacetAnnotations {topology_revision=>"topologyRevision":Number,color=>"color":Assignments<Text>,support=>"support":Assignments<SupportPaint>,seam=>"seam":Assignments<SeamPaint>,fuzzy_skin=>"fuzzySkin":Assignments<Enabled>,brim=>"brim":Assignments<bool>,refinement=>"refinement":Option<JsonObject>});
record!(EmbossFontProperty {char_gap_mm=>"charGapMm":Number,line_gap_mm=>"lineGapMm":Number,line_height_mm=>"lineHeightMm":Number,boldness_mm=>"boldnessMm":Number,skew=>"skew":Number,per_glyph=>"perGlyph":bool,horizontal=>"horizontal":EmbossHorizontalAlign,vertical=>"vertical":EmbossVerticalAlign,collection=>"collection":Number});
record!(EmbossProjection {depth_mm=>"depthMm":Number,use_surface=>"useSurface":bool});
record!(EmbossTextConfiguration {text=>"text":Text,style_name=>"styleName":Text,font_descriptor=>"fontDescriptor":Text,font_descriptor_type=>"fontDescriptorType":Text,font=>"font":EmbossFontProperty,projection=>"projection":EmbossProjection,family=>"family":Option<Text>,face_name=>"faceName":Option<Text>,style=>"style":Option<Text>,weight=>"weight":Option<Text>});
record!(EmbossSvgPart {path_in_3mf=>"pathIn3mf":Text,drawing_asset_id=>"drawingAssetId":AssetId,source_path=>"sourcePath":Option<Text>,depth_mm=>"depthMm":Number,use_surface=>"useSurface":bool,width_mm=>"widthMm":Number});
record!(ProjectVolume {id=>"id":VolumeId,name=>"name":Text,role=>"role":VolumeRole,source=>"source":MeshSourceRef,transform=>"transform":Transform,config=>"config":ConfigMap,filament_id=>"filamentId":Option<FilamentId>,annotations=>"annotations":Arc<FacetAnnotations>,emboss_text=>"embossText":Option<Arc<EmbossTextConfiguration>>,emboss_svg=>"embossSvg":Option<Arc<EmbossSvgPart>>,extension_data=>"extensionData":Option<JsonObject>});
record!(ProjectInstance {id=>"id":InstanceId,name=>"name":Option<Text>,transform=>"transform":Transform,printable=>"printable":bool,extension_data=>"extensionData":Option<JsonObject>});
record!(LayerRange {id=>"id":LayerRangeId,min_z_mm=>"minZMm":Number,max_z_mm=>"maxZMm":Number,config=>"config":ConfigMap,filament_id=>"filamentId":Option<FilamentId>});
record!(BrimEarPoint {position_mm=>"positionMm":Vec3,head_front_radius_mm=>"headFrontRadiusMm":Number});
record!(ProjectObject {id=>"id":ObjectId,name=>"name":Text,config=>"config":ConfigMap,filament_id=>"filamentId":Option<FilamentId>,volumes=>"volumes":List<Arc<ProjectVolume>>,instances=>"instances":List<Arc<ProjectInstance>>,layer_ranges=>"layerRanges":List<Arc<LayerRange>>,brim_ears=>"brimEars":Option<List<BrimEarPoint>>,layer_height_profile=>"layerHeightProfile":Option<List<Number>>,extension_data=>"extensionData":Option<JsonObject>});
record!(WipeTowerState {enabled=>"enabled":bool,position_mm=>"positionMm":[Number;2],rotation_deg=>"rotationDeg":Number,filament_id=>"filamentId":Option<FilamentId>});
record!(ProjectPlate {id=>"id":PlateId,name=>"name":Text,order=>"order":Number,printable=>"printable":bool,config=>"config":ConfigMap,objects=>"objects":List<Arc<ProjectObject>>,wipe_tower=>"wipeTower":Option<Arc<WipeTowerState>>,extension_data=>"extensionData":Option<JsonObject>});
record!(PhysicalFilament {id=>"id":PhysicalFilamentId,name=>"name":Text,tool_id=>"toolId":Number,preset_id=>"presetId":Option<Text>,preset_hash=>"presetHash":Option<Text>,material=>"material":Text,vendor=>"vendor":Option<Text>,color=>"color":Text,nozzle_diameter_mm=>"nozzleDiameterMm":Option<Number>,config=>"config":ConfigMap,enabled=>"enabled":bool,extension_data=>"extensionData":Option<JsonObject>});
record!(MixedComponent {filament_id=>"filamentId":PhysicalFilamentId,weight=>"weight":Number});
record!(FullSpectrumRecipeState {schema_version=>"schemaVersion":SchemaVersion,upstream_stable_id=>"upstreamStableId":Text,ui_mode=>"uiMode":FullSpectrumUiMode,component_a_id=>"componentAId":PhysicalFilamentId,component_b_id=>"componentBId":PhysicalFilamentId,ratio_a=>"ratioA":Number,ratio_b=>"ratioB":Number,mix_b_percent=>"mixBPercent":Number,manual_pattern_groups=>"manualPatternGroups":List<List<PhysicalFilamentId>>,gradient_component_ids=>"gradientComponentIds":List<PhysicalFilamentId>,gradient_component_weights=>"gradientComponentWeights":List<Number>,pointillism_all_filaments=>"pointillismAllFilaments":Disabled,distribution_mode=>"distributionMode":DistributionMode,local_z_max_sublayers=>"localZMaxSublayers":Number,gradient_enabled=>"gradientEnabled":bool,gradient_start=>"gradientStart":Number,gradient_end=>"gradientEnd":Number,component_a_surface_offset_mm=>"componentASurfaceOffsetMm":Number,component_b_surface_offset_mm=>"componentBSurfaceOffsetMm":Number,deleted=>"deleted":bool,custom=>"custom":bool,origin_auto=>"originAuto":bool});
text_enum!(RatioMode { Ratio=>"ratio" });
text_enum!(CycleMode { Cycle=>"cycle" });
text_enum!(MatchMode { Match=>"match" });
text_enum!(GradientMode { Gradient=>"gradient" });
record!(RatioDistribution {mode=>"mode":RatioMode});
record!(CycleDistribution {mode=>"mode":CycleMode,cycle_length_mm=>"cycleLengthMm":Option<Number>});
record!(MatchDistribution {mode=>"mode":MatchMode,target_color=>"targetColor":Text});
record!(GradientDistribution {mode=>"mode":GradientMode,start_z_mm=>"startZMm":Option<Number>,end_z_mm=>"endZMm":Option<Number>,start_weights=>"startWeights":List<Number>,end_weights=>"endWeights":List<Number>});
#[derive(Debug, Clone, PartialEq)]
pub enum MixedDistribution {
    Ratio(RatioDistribution),
    Cycle(CycleDistribution),
    Match(MatchDistribution),
    Gradient(GradientDistribution),
}
impl Decode for MixedDistribution {
    fn from_value(value: Value) -> Result<Self, ShapeError> {
        let Value::Object(fields) = &value else {
            return Err(ShapeError::new(ShapeErrorCode::ExpectedObject));
        };
        let mode = fields
            .get(&"mode".encode_utf16().collect::<Vec<_>>())
            .ok_or_else(|| {
                ShapeError::new(ShapeErrorCode::MissingField).at(PathPart::Field("mode"))
            })?;
        let Value::String(mode) = mode else {
            return Err(ShapeError::new(ShapeErrorCode::ExpectedText).at(PathPart::Field("mode")));
        };
        if mode.iter().copied().eq("ratio".encode_utf16()) {
            RatioDistribution::from_value(value).map(Self::Ratio)
        } else if mode.iter().copied().eq("cycle".encode_utf16()) {
            CycleDistribution::from_value(value).map(Self::Cycle)
        } else if mode.iter().copied().eq("match".encode_utf16()) {
            MatchDistribution::from_value(value).map(Self::Match)
        } else if mode.iter().copied().eq("gradient".encode_utf16()) {
            GradientDistribution::from_value(value).map(Self::Gradient)
        } else {
            Err(ShapeError::new(ShapeErrorCode::InvalidLiteral).at(PathPart::Field("mode")))
        }
    }
}
impl Encode for MixedDistribution {
    fn matches_value(&self, value: &Value) -> io::Result<bool> {
        match self {
            Self::Ratio(v) => v.matches_value(value),
            Self::Cycle(v) => v.matches_value(value),
            Self::Match(v) => v.matches_value(value),
            Self::Gradient(v) => v.matches_value(value),
        }
    }
    fn write_json(&self, out: &mut dyn Write) -> io::Result<()> {
        match self {
            Self::Ratio(v) => v.write_json(out),
            Self::Cycle(v) => v.write_json(out),
            Self::Match(v) => v.write_json(out),
            Self::Gradient(v) => v.write_json(out),
        }
    }
    fn to_value(&self) -> io::Result<Value> {
        match self {
            Self::Ratio(v) => v.to_value(),
            Self::Cycle(v) => v.to_value(),
            Self::Match(v) => v.to_value(),
            Self::Gradient(v) => v.to_value(),
        }
    }
}
record!(MixedFilament {id=>"id":MixedFilamentId,name=>"name":Text,display_color=>"displayColor":Text,components=>"components":List<MixedComponent>,distribution=>"distribution":MixedDistribution,full_spectrum=>"fullSpectrum":Option<Arc<FullSpectrumRecipeState>>,config=>"config":ConfigMap,enabled=>"enabled":bool,extension_data=>"extensionData":Option<JsonObject>});
record!(CustomGcodeLayerEvent {kind=>"type":LayerEventType,top_z_mm=>"topZMm":Number,tool_index=>"toolIndex":Option<Number>,filament_id=>"filamentId":Option<FilamentId>,color=>"color":Option<Text>,message=>"message":Option<Text>});
record!(CustomGcode {id=>"id":CustomGcodeId,scope=>"scope":GcodeScope,plate_id=>"plateId":Option<PlateId>,trigger=>"trigger":GcodeTrigger,code=>"code":Text,layer_event=>"layerEvent":Option<Arc<CustomGcodeLayerEvent>>});
record!(ProjectThumbnail {id=>"id":ThumbnailId,asset_id=>"assetId":AssetId,plate_id=>"plateId":Option<PlateId>,width=>"width":Number,height=>"height":Number});
record!(ExtensionBlob {id=>"id":ExtensionBlobId,namespace=>"namespace":Text,path=>"path":Text,asset_id=>"assetId":AssetId,relationships=>"relationships":List<Text>});
record!(Printer {profile_id=>"profileId":Option<Text>,profile_hash=>"profileHash":Option<Text>,tool_count=>"toolCount":Number});
record!(Filaments {physical=>"physical":List<Arc<PhysicalFilament>>,mixed=>"mixed":List<Arc<MixedFilament>>});
record!(ProjectState {schema_version=>"schemaVersion":SchemaVersion,id=>"id":ProjectId,name=>"name":Text,created_at=>"createdAt":Text,updated_at=>"updatedAt":Text,printer=>"printer":Printer,settings_base_config=>"settingsBaseConfig":Option<ConfigMap>,settings_overrides=>"settingsOverrides":Option<ConfigMap>,config=>"config":ConfigMap,active_plate_id=>"activePlateId":PlateId,plates=>"plates":List<Arc<ProjectPlate>>,filaments=>"filaments":Filaments,source_assets=>"sourceAssets":List<Arc<SourceAssetDescriptor>>,custom_gcode=>"customGcode":List<Arc<CustomGcode>>,thumbnails=>"thumbnails":List<Arc<ProjectThumbnail>>,extension_blobs=>"extensionBlobs":List<Arc<ExtensionBlob>>,extension_data=>"extensionData":Option<JsonObject>});

pub fn identity_transform() -> Transform {
    Transform {
        translation_mm: [Number::new(0.0).unwrap(); 3],
        rotation: [
            Number::new(0.0).unwrap(),
            Number::new(0.0).unwrap(),
            Number::new(0.0).unwrap(),
            Number::new(1.0).unwrap(),
        ],
        scale: [Number::new(1.0).unwrap(); 3],
        extra: ExtraFields::default(),
    }
}
/// The host injects its timestamp; UUID allocation order matches the browser.
pub fn empty_project(
    ids: &mut impl IdSource,
    now: Text,
    name: Option<Text>,
    first_plate_name: Option<Text>,
    tool_count: Option<Number>,
) -> ProjectState {
    let plate_id = ids.next();
    let project_id = ids.next();
    let config = || JsonObject::new(Value::Object(BTreeMap::new())).expect("empty configuration");
    ProjectState {
        schema_version: SchemaVersion::One,
        id: project_id,
        name: name.unwrap_or_else(|| Text::from_utf8("Untitled project")),
        created_at: now.clone(),
        updated_at: now,
        printer: Printer {
            profile_id: None,
            profile_hash: None,
            tool_count: tool_count.unwrap_or(Number::new(1.0).unwrap()),
            extra: ExtraFields::default(),
        },
        settings_base_config: None,
        settings_overrides: None,
        config: config(),
        active_plate_id: plate_id.clone(),
        plates: vec![Arc::new(ProjectPlate {
            id: plate_id,
            name: first_plate_name.unwrap_or_else(|| Text::from_utf8("Plate 1")),
            order: Number::new(0.0).unwrap(),
            printable: true,
            config: config(),
            objects: Arc::from([]),
            wipe_tower: None,
            extension_data: None,
            extra: ExtraFields::default(),
        })]
        .into(),
        filaments: Filaments {
            physical: Arc::from([]),
            mixed: Arc::from([]),
            extra: ExtraFields::default(),
        },
        source_assets: Arc::from([]),
        custom_gcode: Arc::from([]),
        thumbnails: Arc::from([]),
        extension_blobs: Arc::from([]),
        extension_data: None,
        extra: ExtraFields::default(),
    }
}
