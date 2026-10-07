use super::*;

#[derive(Clone)]
pub(super) enum Target {
    Object(ObjectId),
    Volume(VolumeId),
    Instance(InstanceId),
}
#[derive(Clone)]
pub(super) enum ObjectCommand {
    Rename {
        target: Target,
        name: Text,
        previous: Option<Option<Text>>,
    },
    Printable {
        id: InstanceId,
        value: bool,
        previous: Option<bool>,
    },
}
impl ObjectCommand {
    pub(super) fn rename(target: Target, units: Vec<u16>) -> Result<Self, PreparationError> {
        let start = units
            .iter()
            .position(|u| !crate::ids::ecmascript_whitespace(*u));
        let Some(start) = start else {
            let kind = match target {
                Target::Object(_) => "Object",
                Target::Volume(_) => "Volume",
                Target::Instance(_) => "Instance",
            };
            return Err(PreparationError::Domain(Text::from_utf8(&format!(
                "{kind} name cannot be empty"
            ))));
        };
        let end = units
            .iter()
            .rposition(|u| !crate::ids::ecmascript_whitespace(*u))
            .expect("nonblank")
            + 1;
        Ok(Self::Rename {
            target,
            name: Text::new(units[start..end].to_vec()),
            previous: None,
        })
    }
    pub(super) fn label(&self) -> Text {
        match self {
            Self::Rename { target, name, .. } => text_parts(
                match target {
                    Target::Object(_) => "Rename object to ",
                    Target::Volume(_) => "Rename volume to ",
                    Target::Instance(_) => "Rename instance to ",
                },
                name.units(),
                "",
            ),
            Self::Printable { value, .. } => Text::from_utf8(if *value {
                "Mark instance printable"
            } else {
                "Mark instance unprintable"
            }),
        }
    }
    pub(super) fn reason(&self) -> &'static str {
        match self {
            Self::Rename { target, .. } => match target {
                Target::Object(_) => "rename-object",
                Target::Volume(_) => "rename-volume",
                Target::Instance(_) => "rename-instance",
            },
            Self::Printable { .. } => "set-instance-printable",
        }
    }
    pub(super) fn is_noop<E>(&self, state: &ProjectState) -> Result<bool, CommandError<E>> {
        Ok(match self {
            Self::Rename { target, name, .. } => read_name(state, target)? == Some(name),
            Self::Printable { id, value, .. } => instance(state, id)?.printable == *value,
        })
    }
    pub(super) fn apply<E>(&mut self, state: &mut ProjectState) -> Result<(), CommandError<E>> {
        match self {
            Self::Rename {
                target,
                name,
                previous,
            } => {
                *previous = Some(read_name(state, target)?.cloned());
                set_name(state, target, Some(name.clone()))?;
            }
            Self::Printable {
                id,
                value,
                previous,
            } => {
                let instance = instance_mut(state, id)?;
                *previous = Some(instance.printable);
                instance.printable = *value;
            }
        }
        Ok(())
    }
    pub(super) fn revert<E>(&self, state: &mut ProjectState) -> Result<(), CommandError<E>> {
        match self {
            Self::Rename {
                target, previous, ..
            } => {
                let name = previous.clone().ok_or_else(|| {
                    unapplied(match target {
                        Target::Object(_) => "RenameObjectCommand",
                        Target::Volume(_) => "RenameVolumeCommand",
                        Target::Instance(_) => "RenameInstanceCommand",
                    })
                })?;
                set_name(state, target, name)?;
            }
            Self::Printable { id, previous, .. } => {
                let value = previous.ok_or_else(|| unapplied("SetInstancePrintableCommand"))?;
                instance_mut(state, id)?.printable = value;
            }
        }
        Ok(())
    }
}
fn missing<E>(kind: &str, units: &[u16]) -> CommandError<E> {
    CommandError::Domain(text_parts(&format!("Unknown {kind} "), units, ""))
}
fn read_name<'a, E>(
    state: &'a ProjectState,
    target: &Target,
) -> Result<Option<&'a Text>, CommandError<E>> {
    match target {
        Target::Object(id) => Ok(Some(
            &find_object(state, id)
                .ok_or_else(|| missing("object", id.as_utf16()))?
                .1
                .name,
        )),
        Target::Volume(id) => Ok(Some(
            &find_volume(state, id)
                .ok_or_else(|| missing("volume", id.as_utf16()))?
                .2
                .name,
        )),
        Target::Instance(id) => Ok(instance(state, id)?.name.as_ref()),
    }
}
fn set_name<E>(
    state: &mut ProjectState,
    target: &Target,
    name: Option<Text>,
) -> Result<(), CommandError<E>> {
    match target {
        Target::Instance(id) => instance_mut(state, id)?.name = name,
        Target::Object(id) => {
            let (p, o) = state
                .plates
                .iter()
                .enumerate()
                .find_map(|(p, plate)| {
                    plate
                        .objects
                        .iter()
                        .position(|o| &o.id == id)
                        .map(|o| (p, o))
                })
                .ok_or_else(|| missing("object", id.as_utf16()))?;
            object_at_mut(state, p, o).name = name.expect("object names are required");
        }
        Target::Volume(id) => {
            let (p, o, v) = state
                .plates
                .iter()
                .enumerate()
                .find_map(|(p, plate)| {
                    plate.objects.iter().enumerate().find_map(|(o, object)| {
                        object
                            .volumes
                            .iter()
                            .position(|v| &v.id == id)
                            .map(|v| (p, o, v))
                    })
                })
                .ok_or_else(|| missing("volume", id.as_utf16()))?;
            let object = object_at_mut(state, p, o);
            Arc::make_mut(&mut Arc::make_mut(&mut object.volumes)[v]).name =
                name.expect("volume names are required");
        }
    }
    Ok(())
}
fn object_at_mut(state: &mut ProjectState, p: usize, o: usize) -> &mut ProjectObject {
    let plate = Arc::make_mut(&mut Arc::make_mut(&mut state.plates)[p]);
    Arc::make_mut(&mut Arc::make_mut(&mut plate.objects)[o])
}
pub(super) fn instance<'a, E>(
    state: &'a ProjectState,
    id: &InstanceId,
) -> Result<&'a ProjectInstance, CommandError<E>> {
    find_instance(state, id)
        .map(|(_, _, i)| i)
        .ok_or_else(|| missing("instance", id.as_utf16()))
}
pub(super) fn instance_mut<'a, E>(
    state: &'a mut ProjectState,
    id: &InstanceId,
) -> Result<&'a mut ProjectInstance, CommandError<E>> {
    let (p, o, i) = state
        .plates
        .iter()
        .enumerate()
        .find_map(|(p, plate)| {
            plate.objects.iter().enumerate().find_map(|(o, object)| {
                object
                    .instances
                    .iter()
                    .position(|i| &i.id == id)
                    .map(|i| (p, o, i))
            })
        })
        .ok_or_else(|| missing("instance", id.as_utf16()))?;
    let object = object_at_mut(state, p, o);
    Ok(Arc::make_mut(&mut Arc::make_mut(&mut object.instances)[i]))
}
