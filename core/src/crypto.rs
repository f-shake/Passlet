//! 密钥派生与整文件加解密。
//!
//! 容器格式（全部小端无关，纯字节序）：
//! ```text
//! 0   .. 8    "PASSLET1"        magic，末位是版本号
//! 8   .. 24   salt              16 字节，换主密码时重生成
//! 24  .. 48   nonce             24 字节，每次写盘重生成
//! 48  ..      ciphertext + tag  XChaCha20-Poly1305(JSON 明文)
//! ```
//! AAD 取 magic 本身：头部被改过就解不开，不需要额外做完整性校验。

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use rand::{rngs::OsRng, RngCore};
use zeroize::Zeroizing;

use crate::error::{AppError, AppResult};

pub const MAGIC: &[u8; 8] = b"PASSLET1";
const MAGIC_PREFIX: &[u8; 7] = b"PASSLET";
pub const SALT_LEN: usize = 16;
pub const NONCE_LEN: usize = 24;
pub const KEY_LEN: usize = 32;
const TAG_LEN: usize = 16;
const HEADER_LEN: usize = 8 + SALT_LEN + NONCE_LEN;

// Argon2id 参数：32 MiB / 3 轮 / 1 并行。
// 32 MiB 是"够安全且家用机不难受"的折中——用户机器常同时在跑 ffmpeg。
const M_COST_KIB: u32 = 32 * 1024;
const T_COST: u32 = 3;
const P_COST: u32 = 1;

pub type Key = Zeroizing<[u8; KEY_LEN]>;

pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut buf = [0u8; N];
    OsRng.fill_bytes(&mut buf);
    buf
}

pub fn new_salt() -> [u8; SALT_LEN] {
    random_bytes()
}

pub fn derive_key(master: &str, salt: &[u8; SALT_LEN]) -> AppResult<Key> {
    let params = Params::new(M_COST_KIB, T_COST, P_COST, Some(KEY_LEN))
        .map_err(|err| AppError::new("crypto", format!("加密参数不合法：{err}")))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key: Key = Zeroizing::new([0u8; KEY_LEN]);
    argon
        .hash_password_into(master.as_bytes(), salt, key.as_mut())
        .map_err(|err| AppError::new("crypto", format!("密钥派生失败：{err}")))?;
    Ok(key)
}

pub fn encrypt(key: &Key, plaintext: &[u8]) -> AppResult<([u8; NONCE_LEN], Vec<u8>)> {
    let nonce: [u8; NONCE_LEN] = random_bytes();
    let cipher = XChaCha20Poly1305::new_from_slice(key.as_ref())
        .map_err(|_| AppError::new("crypto", "密钥长度不合法。"))?;
    let ciphertext = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad: MAGIC,
            },
        )
        .map_err(|_| AppError::new("crypto", "加密失败。"))?;
    Ok((nonce, ciphertext))
}

pub fn decrypt(
    key: &Key,
    nonce: &[u8; NONCE_LEN],
    ciphertext: &[u8],
) -> AppResult<Zeroizing<Vec<u8>>> {
    let cipher = XChaCha20Poly1305::new_from_slice(key.as_ref())
        .map_err(|_| AppError::new("crypto", "密钥长度不合法。"))?;
    let plaintext = cipher
        .decrypt(
            XNonce::from_slice(nonce),
            Payload {
                msg: ciphertext,
                aad: MAGIC,
            },
        )
        // AEAD 认证失败只有两种可能：密码不对、文件被改过。对用户来说是一句话。
        .map_err(|_| {
            AppError::new(
                "decrypt_failed",
                "主密码不对，或者数据文件已损坏。如果刚改过环境变量，请确认它和原来的主密码一致。",
            )
        })?;
    Ok(Zeroizing::new(plaintext))
}

pub fn encode(salt: &[u8; SALT_LEN], nonce: &[u8; NONCE_LEN], ciphertext: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(HEADER_LEN + ciphertext.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(salt);
    out.extend_from_slice(nonce);
    out.extend_from_slice(ciphertext);
    out
}

#[derive(Debug)]
pub struct Container<'a> {
    pub salt: [u8; SALT_LEN],
    pub nonce: [u8; NONCE_LEN],
    pub ciphertext: &'a [u8],
}

pub fn decode(bytes: &[u8]) -> AppResult<Container<'_>> {
    if bytes.len() < HEADER_LEN + TAG_LEN {
        return Err(AppError::new(
            "corrupt",
            "这个文件不是 Passlet 的数据文件（太短）。",
        ));
    }
    if &bytes[..7] != MAGIC_PREFIX {
        return Err(AppError::new(
            "corrupt",
            "这个文件不是 Passlet 的数据文件（头部标记不匹配）。",
        ));
    }
    if bytes[7] != MAGIC[7] {
        return Err(AppError::new(
            "version",
            "数据文件版本比当前程序新，请升级 Passlet。",
        ));
    }

    let mut salt = [0u8; SALT_LEN];
    salt.copy_from_slice(&bytes[8..8 + SALT_LEN]);

    let mut nonce = [0u8; NONCE_LEN];
    nonce.copy_from_slice(&bytes[8 + SALT_LEN..HEADER_LEN]);

    Ok(Container {
        salt,
        nonce,
        ciphertext: &bytes[HEADER_LEN..],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key_for(password: &str, salt: &[u8; SALT_LEN]) -> Key {
        derive_key(password, salt).expect("派生密钥")
    }

    #[test]
    fn 相同密码与盐派生出相同密钥_不同盐则不同() {
        let salt_a = [7u8; SALT_LEN];
        let salt_b = [9u8; SALT_LEN];
        let a1 = key_for("master-password", &salt_a);
        let a2 = key_for("master-password", &salt_a);
        let b = key_for("master-password", &salt_b);
        assert_eq!(*a1, *a2);
        assert_ne!(*a1, *b);
    }

    #[test]
    fn 加解密往返后与原文一致() {
        let salt = new_salt();
        let key = key_for("master", &salt);
        let plaintext = br#"{"version":1,"entries":[]}"#;
        let (nonce, ciphertext) = encrypt(&key, plaintext).unwrap();
        let bytes = encode(&salt, &nonce, &ciphertext);

        let parsed = decode(&bytes).unwrap();
        assert_eq!(parsed.salt, salt);
        let back = decrypt(&key, &parsed.nonce, parsed.ciphertext).unwrap();
        assert_eq!(&back[..], plaintext);
    }

    #[test]
    fn 错误密码解密失败且错误码是_decrypt_failed() {
        let salt = new_salt();
        let key = key_for("correct", &salt);
        let (nonce, ciphertext) = encrypt(&key, b"secret").unwrap();
        let wrong = key_for("wrong", &salt);
        let err = decrypt(&wrong, &nonce, &ciphertext).unwrap_err();
        assert_eq!(err.code, "decrypt_failed");
    }

    #[test]
    fn 密文被改动一个字节就解不开() {
        let salt = new_salt();
        let key = key_for("master", &salt);
        let (nonce, mut ciphertext) = encrypt(&key, b"secret payload").unwrap();
        ciphertext[0] ^= 0xFF;
        assert!(decrypt(&key, &nonce, &ciphertext).is_err());
    }

    #[test]
    fn 头部被改动也解不开() {
        let salt = new_salt();
        let key = key_for("master", &salt);
        let (nonce, ciphertext) = encrypt(&key, b"secret payload").unwrap();
        let mut bytes = encode(&salt, &nonce, &ciphertext);
        bytes[0] = b'X';
        // magic 被改 → 连容器校验都过不去
        assert_eq!(decode(&bytes).unwrap_err().code, "corrupt");
    }

    #[test]
    fn 每次加密的盐与随机数不同() {
        let key = key_for("master", &[1u8; SALT_LEN]);
        let (n1, c1) = encrypt(&key, b"same").unwrap();
        let (n2, c2) = encrypt(&key, b"same").unwrap();
        assert_ne!(n1, n2);
        assert_ne!(c1, c2);
    }

    #[test]
    fn 空明文与超长明文都能往返() {
        let salt = new_salt();
        let key = key_for("master", &salt);

        let (nonce, ct) = encrypt(&key, b"").unwrap();
        assert!(decrypt(&key, &nonce, &ct).unwrap().is_empty());

        let big = vec![b'a'; 1024 * 1024];
        let (nonce, ct) = encrypt(&key, &big).unwrap();
        assert_eq!(&decrypt(&key, &nonce, &ct).unwrap()[..], &big[..]);
    }

    #[test]
    fn 截断的文件被判为损坏() {
        let salt = new_salt();
        let key = key_for("master", &salt);
        let (nonce, ct) = encrypt(&key, b"x").unwrap();
        let bytes = encode(&salt, &nonce, &ct);
        let err = decode(&bytes[..20]).unwrap_err();
        assert_eq!(err.code, "corrupt");
    }

    #[test]
    fn 版本号更高时报_version() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"PASSLET2");
        bytes.extend_from_slice(&[0u8; SALT_LEN]);
        bytes.extend_from_slice(&[0u8; NONCE_LEN]);
        bytes.extend_from_slice(&[0u8; TAG_LEN]);
        assert_eq!(decode(&bytes).unwrap_err().code, "version");
    }

    #[test]
    fn 空文件被判为损坏() {
        assert_eq!(decode(&[]).unwrap_err().code, "corrupt");
    }
}
