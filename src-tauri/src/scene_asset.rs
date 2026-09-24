//! Immutable, local GLB assets shared by the scene editor and Tripo collection.
//! Only verified content in this directory may be exposed to the asset protocol.

use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

const MAX_IMPORT: usize = 64 * 1024 * 1024;
const MAX_BUNDLE: usize = 128 * 1024 * 1024;
const MAX_JSON: usize = 8 * 1024 * 1024;
const MAX_IMAGE_BYTES: usize = 16 * 1024 * 1024;
const MAX_TEXTURE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_GEOMETRY_BYTES: u64 = 256 * 1024 * 1024;

fn invalid() -> String {
    "GLB素材の形式が不正です".into()
}
fn io_error(_: impl std::fmt::Display) -> String {
    "3D素材を保存・確認できませんでした".into()
}
fn valid_hash(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn bounded(items: &Value, limit: usize) -> Result<(), String> {
    if !items.is_null() && items.as_array().is_none_or(|items| items.len() > limit) {
        return Err("3D素材が複雑すぎます".into());
    }
    Ok(())
}

fn image_dimensions(data: &[u8], mime: &str) -> Result<(u64, u64), String> {
    let bad = || "3D素材の画像形式・寸法が不正です".to_string();
    let read16 = |part: &[u8]| u16::from_be_bytes([part[0], part[1]]) as u64;
    let read32 = |part: &[u8]| u32::from_be_bytes(part.try_into().unwrap()) as u64;
    match mime {
        "image/png"
            if data.len() >= 24
                && data.starts_with(b"\x89PNG\r\n\x1a\n")
                && &data[12..16] == b"IHDR" =>
        {
            Ok((read32(&data[16..20]), read32(&data[20..24])))
        }
        "image/jpeg" if data.starts_with(b"\xff\xd8") => {
            let mut offset = 2;
            while offset + 4 <= data.len() {
                if data[offset] != 0xff {
                    return Err(bad());
                }
                while offset < data.len() && data[offset] == 0xff {
                    offset += 1;
                }
                if offset >= data.len() {
                    break;
                }
                let marker = data[offset];
                offset += 1;
                if marker == 0xd8 || marker == 0x01 || (0xd0..=0xd7).contains(&marker) {
                    continue;
                }
                if marker == 0xd9 || marker == 0xda || offset + 2 > data.len() {
                    break;
                }
                let size = read16(&data[offset..offset + 2]) as usize;
                if size < 2 || size > data.len() - offset {
                    return Err(bad());
                }
                if matches!(marker, 0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf) {
                    if size < 7 {
                        return Err(bad());
                    }
                    return Ok((
                        read16(&data[offset + 5..offset + 7]),
                        read16(&data[offset + 3..offset + 5]),
                    ));
                }
                offset += size;
            }
            Err(bad())
        }
        "image/webp" if data.len() >= 30 && &data[..4] == b"RIFF" && &data[8..12] == b"WEBP" => {
            let payload = &data[20..];
            if &data[12..16] == b"VP8X" {
                Ok((
                    1 + u32::from_le_bytes([payload[4], payload[5], payload[6], 0]) as u64,
                    1 + u32::from_le_bytes([payload[7], payload[8], payload[9], 0]) as u64,
                ))
            } else if &data[12..16] == b"VP8L" && payload[0] == 0x2f {
                Ok((
                    1 + payload[1] as u64 + (((payload[2] & 0x3f) as u64) << 8),
                    1 + ((payload[2] as u64) >> 6)
                        + ((payload[3] as u64) << 2)
                        + (((payload[4] & 0xf) as u64) << 10),
                ))
            } else if &data[12..16] == b"VP8 " && &payload[3..6] == b"\x9d\x01\x2a" {
                Ok((
                    (u16::from_le_bytes([payload[6], payload[7]]) & 0x3fff) as u64,
                    (u16::from_le_bytes([payload[8], payload[9]]) & 0x3fff) as u64,
                ))
            } else {
                Err(bad())
            }
        }
        _ => Err(bad()),
    }
}

fn resource_budget(gltf: &Value, bin: Option<&[u8]>) -> Result<(), String> {
    for (key, maximum) in [
        ("meshes", 256),
        ("nodes", 2048),
        ("skins", 64),
        ("accessors", 4096),
        ("bufferViews", 4096),
        ("images", 64),
        ("textures", 128),
        ("animations", 128),
    ] {
        bounded(&gltf[key], maximum)?;
    }
    let blocked = [
        "KHR_draco_mesh_compression",
        "EXT_meshopt_compression",
        "KHR_texture_basisu",
        "EXT_texture_avif",
        "EXT_mesh_gpu_instancing",
    ];
    for key in ["extensionsUsed", "extensionsRequired"] {
        if gltf[key].as_array().is_some_and(|items| {
            items
                .iter()
                .any(|item| item.as_str().is_none_or(|name| blocked.contains(&name)))
        }) {
            return Err("未対応の圧縮3D素材です".into());
        }
    }
    // Do not trust an extension merely because the generator forgot to list it.
    fn blocked_nested(value: &Value, blocked: &[&str]) -> bool {
        match value {
            Value::Object(object) => object.iter().any(|(key, value)| {
                (key == "extensions"
                    && value
                        .as_object()
                        .is_some_and(|map| map.keys().any(|name| blocked.contains(&name.as_str()))))
                    || blocked_nested(value, blocked)
            }),
            Value::Array(items) => items.iter().any(|item| blocked_nested(item, blocked)),
            _ => false,
        }
    }
    if blocked_nested(gltf, &blocked) {
        return Err("未対応の圧縮3D素材です".into());
    }
    let mut vertex_total: u64 = 0;
    for mesh in gltf["meshes"].as_array().into_iter().flatten() {
        bounded(&mesh["primitives"], 1024)?;
        for primitive in mesh["primitives"].as_array().into_iter().flatten() {
            let position = primitive["attributes"]["POSITION"].as_u64();
            if let Some(index) = position {
                let accessor = gltf["accessors"].get(index as usize).ok_or_else(invalid)?;
                vertex_total = vertex_total
                    .checked_add(accessor["count"].as_u64().ok_or_else(invalid)?)
                    .ok_or_else(invalid)?;
                if vertex_total > 1_000_000 {
                    return Err("3D素材の頂点数が多すぎます".into());
                }
            }
        }
    }
    let mut joint_count = 0;
    for skin in gltf["skins"].as_array().into_iter().flatten() {
        let count = skin["joints"].as_array().ok_or_else(invalid)?.len();
        joint_count += count;
        if count > 256 || joint_count > 512 {
            return Err("3D素材の骨数が多すぎます".into());
        }
    }
    let mut geometry_bytes = 0u64;
    for accessor in gltf["accessors"].as_array().into_iter().flatten() {
        let count = accessor["count"].as_u64().ok_or_else(invalid)?;
        let components = match accessor["type"].as_str() {
            Some("SCALAR") => 1,
            Some("VEC2") => 2,
            Some("VEC3") => 3,
            Some("VEC4") => 4,
            Some("MAT2") => 4,
            Some("MAT3") => 9,
            Some("MAT4") => 16,
            _ => return Err(invalid()),
        };
        let size = match accessor["componentType"].as_u64() {
            Some(5120 | 5121) => 1,
            Some(5122 | 5123) => 2,
            Some(5125 | 5126) => 4,
            _ => return Err(invalid()),
        };
        geometry_bytes = geometry_bytes
            .checked_add(count.checked_mul(components * size).ok_or_else(invalid)?)
            .ok_or_else(invalid)?;
        if geometry_bytes > MAX_GEOMETRY_BYTES {
            return Err("3D素材の展開後メッシュが大きすぎます".into());
        }
        if accessor["sparse"]["count"]
            .as_u64()
            .is_some_and(|sparse| sparse > count)
        {
            return Err(invalid());
        }
    }
    let views = gltf["bufferViews"].as_array();
    let mut texture_bytes = 0u64;
    for image in gltf["images"].as_array().into_iter().flatten() {
        let (content, mime): (Vec<u8>, &str) = if let Some(uri) = image["uri"].as_str() {
            let (prefix, encoded) = uri.split_once(',').ok_or_else(invalid)?;
            let mime = prefix
                .strip_prefix("data:")
                .and_then(|s| s.strip_suffix(";base64"))
                .ok_or_else(invalid)?;
            if encoded.len() > MAX_IMAGE_BYTES.div_ceil(3) * 4 + 4 {
                return Err("3D素材の画像データが大きすぎます".into());
            }
            (STANDARD.decode(encoded).map_err(|_| invalid())?, mime)
        } else {
            let view = views
                .and_then(|v| v.get(image["bufferView"].as_u64()? as usize))
                .ok_or_else(invalid)?;
            if view["buffer"] != 0 {
                return Err(invalid());
            }
            let offset = view["byteOffset"].as_u64().unwrap_or(0) as usize;
            let length = view["byteLength"].as_u64().ok_or_else(invalid)? as usize;
            if length > MAX_IMAGE_BYTES {
                return Err("3D素材の画像データが大きすぎます".into());
            }
            let binary = bin.ok_or_else(invalid)?;
            let end = offset.checked_add(length).ok_or_else(invalid)?;
            (
                binary.get(offset..end).ok_or_else(invalid)?.to_vec(),
                image["mimeType"].as_str().ok_or_else(invalid)?,
            )
        };
        if content.len() > MAX_IMAGE_BYTES {
            return Err("3D素材の画像データが大きすぎます".into());
        }
        let (width, height) = image_dimensions(&content, mime)?;
        if !(1..=4096).contains(&width) || !(1..=4096).contains(&height) {
            return Err("3D素材の画像寸法が大きすぎます".into());
        }
        // RGBA texture plus a conservative allowance for mips/decoder staging.
        texture_bytes = texture_bytes
            .checked_add(
                width
                    .checked_mul(height)
                    .and_then(|px| px.checked_mul(6))
                    .ok_or_else(invalid)?,
            )
            .ok_or_else(invalid)?;
        if texture_bytes > MAX_TEXTURE_BYTES {
            return Err("3D素材の展開後画像が大きすぎます".into());
        }
    }
    Ok(())
}

fn validate_references(gltf: &Value, binary: Option<&[u8]>) -> Result<(), String> {
    let views = gltf["bufferViews"].as_array();
    let accessors = gltf["accessors"].as_array();
    let buffer_size = gltf["buffers"]
        .as_array()
        .and_then(|items| items.first())
        .and_then(|item| item["byteLength"].as_u64());
    for view in views.into_iter().flatten() {
        if view["buffer"] != 0 {
            return Err(invalid());
        }
        let offset = view["byteOffset"].as_u64().unwrap_or(0);
        let length = view["byteLength"].as_u64().ok_or_else(invalid)?;
        let end = offset.checked_add(length).ok_or_else(invalid)?;
        if length == 0
            || buffer_size.is_none_or(|size| end > size)
            || binary.is_none_or(|bytes| end > bytes.len() as u64)
        {
            return Err(invalid());
        }
    }
    for accessor in accessors.into_iter().flatten() {
        // Sparse accessors are deliberately unsupported until their decoded
        // allocation and index ranges can be checked before GLTFLoader runs.
        if accessor.get("sparse").is_some() {
            return Err("未対応の疎な3Dメッシュです".into());
        }
        let index = accessor["bufferView"].as_u64().ok_or_else(invalid)? as usize;
        let view = views
            .and_then(|items| items.get(index))
            .ok_or_else(invalid)?;
        let components: u64 = match accessor["type"].as_str() {
            Some("SCALAR") => 1,
            Some("VEC2") => 2,
            Some("VEC3") => 3,
            Some("VEC4" | "MAT2") => 4,
            Some("MAT3") => 9,
            Some("MAT4") => 16,
            _ => return Err(invalid()),
        };
        let size: u64 = match accessor["componentType"].as_u64() {
            Some(5120 | 5121) => 1,
            Some(5122 | 5123) => 2,
            Some(5125 | 5126) => 4,
            _ => return Err(invalid()),
        };
        let element = components.checked_mul(size).ok_or_else(invalid)?;
        let stride = view["byteStride"].as_u64().unwrap_or(element);
        let count = accessor["count"].as_u64().ok_or_else(invalid)?;
        let offset = accessor["byteOffset"].as_u64().unwrap_or(0);
        if count == 0
            || stride < element
            || stride > 252
            || !offset.is_multiple_of(size)
            || (count - 1)
                .checked_mul(stride)
                .and_then(|n| n.checked_add(offset))
                .and_then(|n| n.checked_add(element))
                .is_none_or(|end| end > view["byteLength"].as_u64().unwrap_or(0))
        {
            return Err(invalid());
        }
    }
    for mesh in gltf["meshes"].as_array().into_iter().flatten() {
        for primitive in mesh["primitives"].as_array().into_iter().flatten() {
            let attributes = primitive["attributes"].as_object().ok_or_else(invalid)?;
            if !attributes.contains_key("POSITION")
                || attributes.values().any(|index| {
                    index.as_u64().is_none_or(|index| {
                        accessors.is_none_or(|items| items.get(index as usize).is_none())
                    })
                })
                || primitive["indices"].as_u64().is_some_and(|index| {
                    accessors.is_none_or(|items| items.get(index as usize).is_none())
                })
            {
                return Err(invalid());
            }
        }
    }
    let nodes = gltf["nodes"].as_array();
    let node_count = nodes.map_or(0, Vec::len);
    let mut parents = vec![0usize; node_count];
    for node in nodes.into_iter().flatten() {
        for (key, collection) in [("mesh", "meshes"), ("skin", "skins"), ("camera", "cameras")] {
            if let Some(reference) = node.get(key) {
                let index = reference.as_u64().ok_or_else(invalid)? as usize;
                if gltf[collection]
                    .as_array()
                    .is_none_or(|items| items.get(index).is_none())
                {
                    return Err(invalid());
                }
            }
        }
        if let Some(children) = node.get("children") {
            for child in children.as_array().ok_or_else(invalid)? {
                let index = child.as_u64().ok_or_else(invalid)? as usize;
                let count = parents.get_mut(index).ok_or_else(invalid)?;
                *count += 1;
                if *count > 1 {
                    return Err(invalid());
                }
            }
        }
    }
    let mut state = vec![0u8; node_count];
    fn visit(index: usize, nodes: &[Value], state: &mut [u8]) -> Result<(), String> {
        match state[index] {
            1 => return Err(invalid()),
            2 => return Ok(()),
            _ => (),
        }
        state[index] = 1;
        for child in nodes[index]["children"].as_array().into_iter().flatten() {
            visit(child.as_u64().ok_or_else(invalid)? as usize, nodes, state)?;
        }
        state[index] = 2;
        Ok(())
    }
    if let Some(nodes) = nodes {
        for index in 0..node_count {
            visit(index, nodes, &mut state)?;
        }
    }
    for scene in gltf["scenes"].as_array().into_iter().flatten() {
        for node in scene["nodes"].as_array().into_iter().flatten() {
            let index = node.as_u64().ok_or_else(invalid)? as usize;
            if nodes.is_none_or(|items| items.get(index).is_none()) {
                return Err(invalid());
            }
        }
    }
    if let Some(index) = gltf["scene"].as_u64() {
        if gltf["scenes"]
            .as_array()
            .is_none_or(|items| items.get(index as usize).is_none())
        {
            return Err(invalid());
        }
    }
    Ok(())
}

pub fn check_glb(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() < 20
        || bytes.len() > MAX_BUNDLE
        || &bytes[..4] != b"glTF"
        || u32::from_le_bytes(bytes[4..8].try_into().map_err(|_| invalid())?) != 2
        || u32::from_le_bytes(bytes[8..12].try_into().map_err(|_| invalid())?) as usize
            != bytes.len()
    {
        return Err(invalid());
    }
    let mut offset = 12usize;
    let mut gltf = None;
    let mut binary = None;
    let mut chunks = 0;
    while offset < bytes.len() {
        if bytes.len() - offset < 8 {
            return Err(invalid());
        }
        let size = u32::from_le_bytes(
            bytes[offset..offset + 4]
                .try_into()
                .map_err(|_| invalid())?,
        ) as usize;
        let kind = &bytes[offset + 4..offset + 8];
        if !size.is_multiple_of(4) || size > bytes.len() - offset - 8 {
            return Err(invalid());
        }
        if chunks == 0 {
            if kind != b"JSON" || size > MAX_JSON {
                return Err(invalid());
            }
            gltf = Some(
                serde_json::from_slice::<Value>(&bytes[offset + 8..offset + 8 + size])
                    .map_err(|_| invalid())?,
            );
        } else if chunks > 1 || kind != b"BIN\0" {
            return Err(invalid());
        } else {
            binary = Some(&bytes[offset + 8..offset + 8 + size]);
        }
        offset += size + 8;
        chunks += 1;
    }
    let gltf = gltf.ok_or_else(invalid)?;
    if gltf["asset"]["version"] != "2.0" {
        return Err(invalid());
    }
    // Binary buffers must live in the GLB itself. Image data URIs are decoded
    // and measured below; neither path can cause a network fetch at render time.
    bounded(&gltf["buffers"], 1)?;
    for buffer in gltf["buffers"].as_array().into_iter().flatten() {
        if buffer.get("uri").is_some() {
            return Err("外部ファイルを参照するGLBは使用できません".into());
        }
        if buffer["byteLength"]
            .as_u64()
            .is_none_or(|length| binary.is_none_or(|bin| length > bin.len() as u64))
        {
            return Err(invalid());
        }
    }
    for image in gltf["images"].as_array().into_iter().flatten() {
        if image["uri"]
            .as_str()
            .is_some_and(|uri| !uri.starts_with("data:"))
        {
            return Err("外部ファイルを参照するGLBは使用できません".into());
        }
    }
    validate_references(&gltf, binary)?;
    resource_budget(&gltf, binary)?;
    Ok(())
}

pub fn directory(root: &Path) -> Result<PathBuf, String> {
    let dir = root.join("scene-assets");
    fs::create_dir_all(&dir).map_err(io_error)?;
    if fs::symlink_metadata(&dir)
        .map_err(io_error)?
        .file_type()
        .is_symlink()
    {
        return Err(io_error("symlink"));
    }
    Ok(dir)
}

pub fn publish(root: &Path, bytes: &[u8]) -> Result<Value, String> {
    check_glb(bytes)?;
    let dir = directory(root)?;
    let hash = format!("{:x}", Sha256::digest(bytes));
    let file = format!("{hash}.glb");
    let path = dir.join(&file);
    if path.exists() {
        verified_path(root, &file, &hash, bytes.len() as u64)?;
    } else {
        let temp = dir.join(format!(".pending-{}", uuid::Uuid::new_v4()));
        let result = (|| -> Result<(), String> {
            let mut output = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temp)
                .map_err(io_error)?;
            output
                .write_all(bytes)
                .and_then(|_| output.sync_all())
                .map_err(io_error)?;
            match fs::hard_link(&temp, &path) {
                Ok(()) => (),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (),
                Err(e) => return Err(io_error(e)),
            }
            verified_path(root, &file, &hash, bytes.len() as u64)?;
            fs::File::open(&dir)
                .and_then(|f| f.sync_all())
                .map_err(io_error)?;
            Ok(())
        })();
        let _ = fs::remove_file(temp);
        result?;
    }
    Ok(json!({"file":file,"hash":hash,"bytes":bytes.len()}))
}

pub fn import_base64(root: &Path, data: &str) -> Result<Value, String> {
    if data.len() > MAX_IMPORT.div_ceil(3) * 4 + 4 {
        return Err("GLBは64MB以下にしてください".into());
    }
    let bytes = STANDARD.decode(data).map_err(|_| invalid())?;
    if bytes.len() > MAX_IMPORT {
        return Err("GLBは64MB以下にしてください".into());
    }
    publish(root, &bytes)
}

pub fn verified_path(root: &Path, file: &str, hash: &str, size: u64) -> Result<PathBuf, String> {
    if !valid_hash(hash) || file != format!("{hash}.glb") {
        return Err("保存済み3D素材の参照が不正です".into());
    }
    let dir = directory(root)?.canonicalize().map_err(io_error)?;
    let path = dir.join(file);
    if fs::symlink_metadata(&path)
        .map_err(io_error)?
        .file_type()
        .is_symlink()
        || path.canonicalize().map_err(io_error)?.parent() != Some(dir.as_path())
    {
        return Err("保存済み3D素材の参照が不正です".into());
    }
    let bytes = fs::read(&path).map_err(io_error)?;
    if bytes.len() as u64 != size || format!("{:x}", Sha256::digest(&bytes)) != hash {
        return Err("保存済み3D素材のハッシュが一致しません".into());
    }
    check_glb(&bytes)?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn glb(json: &str) -> Vec<u8> {
        let mut body = json.as_bytes().to_vec();
        while !body.len().is_multiple_of(4) {
            body.push(b' ');
        }
        let mut bytes = b"glTF".to_vec();
        bytes.extend(2u32.to_le_bytes());
        bytes.extend(((body.len() + 20) as u32).to_le_bytes());
        bytes.extend((body.len() as u32).to_le_bytes());
        bytes.extend(b"JSON");
        bytes.extend(body);
        bytes
    }
    fn glb_with_binary(json: &str, data: &[u8]) -> Vec<u8> {
        let mut bytes = glb(json);
        let mut binary = data.to_vec();
        while !binary.len().is_multiple_of(4) {
            binary.push(0);
        }
        bytes.extend((binary.len() as u32).to_le_bytes());
        bytes.extend(b"BIN\0");
        bytes.extend(binary);
        let length = bytes.len() as u32;
        bytes[8..12].copy_from_slice(&length.to_le_bytes());
        bytes
    }
    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
        bytes.extend(width.to_be_bytes());
        bytes.extend(height.to_be_bytes());
        bytes
    }
    #[test]
    fn rejects_external_resources_and_truncated_glb() {
        assert!(check_glb(&glb(
            r#"{"asset":{"version":"2.0"},"images":[{"uri":"https://example.org/a.png"}]}"#
        ))
        .is_err());
        let embedded = json!({"asset":{"version":"2.0"},"images":[{"uri":format!("data:image/png;base64,{}", STANDARD.encode(png(1,1)))}]});
        assert!(check_glb(&glb(&embedded.to_string())).is_ok());
        assert!(check_glb(&glb(r#"{"asset":{"version":"2.0"},"buffers":[{"uri":"data:application/octet-stream;base64,AQ==","byteLength":1}]}"#)).is_err());
        let mut damaged = glb(r#"{"asset":{"version":"2.0"}}"#);
        damaged.pop();
        assert!(check_glb(&damaged).is_err());
    }
    #[test]
    fn accepts_bounded_embedded_geometry_and_rejects_broken_references() {
        let geometry = json!({"asset":{"version":"2.0"},"buffers":[{"byteLength":36}],
            "bufferViews":[{"buffer":0,"byteLength":36}],
            "accessors":[{"bufferView":0,"componentType":5126,"count":3,"type":"VEC3"}],
            "meshes":[{"primitives":[{"attributes":{"POSITION":0}}]}]});
        let data = vec![0; 36];
        assert!(check_glb(&glb_with_binary(&geometry.to_string(), &data)).is_ok());
        let mut wrong_view = geometry.clone();
        wrong_view["bufferViews"][0]["byteLength"] = json!(40);
        assert!(check_glb(&glb_with_binary(&wrong_view.to_string(), &data)).is_err());
        let mut wrong_accessor = geometry;
        wrong_accessor["accessors"][0]["bufferView"] = json!(4);
        assert!(check_glb(&glb_with_binary(&wrong_accessor.to_string(), &data)).is_err());
        let cycle = json!({"asset":{"version":"2.0"},"nodes":[{"children":[1]},{"children":[0]}]});
        assert!(check_glb(&glb(&cycle.to_string())).is_err());
    }
    #[test]
    fn caps_geometry_bones_decoded_images_and_compression() {
        let huge_mesh = json!({"asset":{"version":"2.0"},"meshes":[{"primitives":[{"attributes":{"POSITION":0}}]}],
            "accessors":[{"count":1_000_001,"type":"VEC3","componentType":5126} ]});
        assert!(check_glb(&glb(&huge_mesh.to_string())).is_err());
        let huge_accessors = json!({"asset":{"version":"2.0"},"accessors":[{"count":5_000_000,"type":"MAT4","componentType":5126}]});
        assert!(check_glb(&glb(&huge_accessors.to_string())).is_err());
        let huge_rig = json!({"asset":{"version":"2.0"},"skins":[{"joints":vec![0;257]}]});
        assert!(check_glb(&glb(&huge_rig.to_string())).is_err());
        let huge_png = json!({"asset":{"version":"2.0"},"images":[{"uri":format!("data:image/png;base64,{}", STANDARD.encode(png(8192,8192)))}]});
        assert!(check_glb(&glb(&huge_png.to_string())).is_err());
        let repeated = format!("data:image/png;base64,{}", STANDARD.encode(png(4096, 4096)));
        let too_many_textures = json!({"asset":{"version":"2.0"},"images":[{"uri":repeated.clone()},{"uri":repeated.clone()},{"uri":repeated}]});
        assert!(check_glb(&glb(&too_many_textures.to_string())).is_err());
        let compressed = json!({"asset":{"version":"2.0"},"meshes":[{"primitives":[{"extensions":{"KHR_draco_mesh_compression":{}}}]}]});
        assert!(check_glb(&glb(&compressed.to_string())).is_err());
    }
    #[test]
    fn recognizes_png_jpeg_and_webp_image_dimensions() {
        assert_eq!(
            image_dimensions(&png(512, 384), "image/png"),
            Ok((512, 384))
        );
        let jpeg = b"\xff\xd8\xff\xc0\0\x11\x08\x01\x80\x02\0\x03\x01\x11\0\x02\x11\0\x03\x11\0";
        assert_eq!(image_dimensions(jpeg, "image/jpeg"), Ok((512, 384)));
        let mut webp = b"RIFF\0\0\0\0WEBPVP8X\x0a\0\0\0\0\0\0\0\xff\x01\0\x7f\x01\0".to_vec();
        assert_eq!(image_dimensions(&webp, "image/webp"), Ok((512, 384)));
        webp[12..16].copy_from_slice(b"VP8 ");
        assert!(image_dimensions(&webp, "image/webp").is_err());
    }
    #[test]
    fn imported_asset_is_content_addressed_and_checked_on_reuse() {
        let temp =
            std::env::temp_dir().join(format!("manga-scene-asset-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&temp).unwrap();
        let data = glb(r#"{"asset":{"version":"2.0"}}"#);
        let first = publish(&temp, &data).unwrap();
        let second = publish(&temp, &data).unwrap();
        assert_eq!(first, second);
        let path = verified_path(
            &temp,
            first["file"].as_str().unwrap(),
            first["hash"].as_str().unwrap(),
            first["bytes"].as_u64().unwrap(),
        )
        .unwrap();
        fs::write(path, b"bad").unwrap();
        assert!(publish(&temp, &data).is_err());
        fs::remove_dir_all(temp).unwrap();
    }
}
