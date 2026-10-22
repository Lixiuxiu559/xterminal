import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { mkdir, lstat, chmod, readFile, writeFile, rm, rename } from 'node:fs/promises';
import { join } from 'node:path';
const run = promisify(execFile);

async function regular(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('证书路径必须为普通文件');
    await chmod(path, 0o600);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
export async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('数据目录不能为符号链接');
  await chmod(path, 0o700);
}
async function openssl(args: string[]): Promise<void> {
  try { await run('openssl', args, { timeout: 30000, maxBuffer: 65536 }); }
  catch { throw new Error('本地 TLS 证书生成失败，请检查 OpenSSL 是否可用'); }
}

/** Private keys stay in local 0600 files and are never included in process output. */
export async function ensureCertificates(dataPath: string, address: string): Promise<{ key: Buffer; cert: Buffer; caCertificatePath: string }> {
  await privateDirectory(dataPath);
  const directory = join(dataPath, 'certificates');
  await privateDirectory(directory);
  const caKey = join(directory, 'ca.key');
  const caCert = join(directory, 'ca.crt');
  const existingKey = await regular(caKey);
  const existingCert = await regular(caCert);
  if (existingKey !== existingCert) throw new Error('本地 CA 文件不完整，拒绝自动替换已有信任');
  if (!existingKey) {
    const config = join(directory, 'ca.cnf');
    const temporaryKey = join(directory, 'ca.new.key');
    const temporaryCert = join(directory, 'ca.new.crt');
    await writeFile(config, '[req]\ndistinguished_name=dn\nx509_extensions=ca\nprompt=no\n[dn]\nCN=XTerminal Local CA\n[ca]\nbasicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n', { mode: 0o600 });
    try {
      await openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '3650', '-config', config, '-keyout', temporaryKey, '-out', temporaryCert]);
      await chmod(temporaryKey, 0o600); await chmod(temporaryCert, 0o600);
      await rename(temporaryKey, caKey); await rename(temporaryCert, caCert);
    } finally {
      await rm(config, { force: true }); await rm(temporaryKey, { force: true }); await rm(temporaryCert, { force: true });
    }
  }
  const ca = new X509Certificate(await readFile(caCert));
  if (!ca.ca || !ca.checkPrivateKey(createPrivateKey(await readFile(caKey))) || Date.parse(ca.validTo) <= Date.now()) throw new Error('本地 CA 无效或已过期');
  const leafKey = join(directory, `server-${address}.key`);
  const leafCert = join(directory, `server-${address}.crt`);
  const keyExists = await regular(leafKey);
  const certExists = await regular(leafCert);
  let valid = false;
  if (keyExists && certExists) {
    try {
      const leaf = new X509Certificate(await readFile(leafCert));
      valid = leaf.checkIP(address) === address && leaf.verify(ca.publicKey) &&
        leaf.checkPrivateKey(createPrivateKey(await readFile(leafKey))) && Date.parse(leaf.validTo) > Date.now() + 86400000;
    } catch { valid = false; }
  }
  if (!valid) {
    const config = join(directory, `server-${address}.cnf`);
    const csr = join(directory, `server-${address}.csr`);
    const temporaryKey = join(directory, `server-${address}.new.key`);
    const temporaryCert = join(directory, `server-${address}.new.crt`);
    await writeFile(config, `[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=${address}\n[leaf]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:${address}\n`, { mode: 0o600 });
    try {
      await openssl(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-config', config, '-keyout', temporaryKey, '-out', csr]);
      await openssl(['x509', '-req', '-in', csr, '-CA', caCert, '-CAkey', caKey, '-set_serial', `0x${Date.now().toString(16)}`, '-days', '365', '-sha256', '-extfile', config, '-extensions', 'leaf', '-out', temporaryCert]);
      await chmod(temporaryKey, 0o600); await chmod(temporaryCert, 0o600);
      await rename(temporaryKey, leafKey); await rename(temporaryCert, leafCert);
    } finally {
      for (const path of [config, csr, temporaryKey, temporaryCert]) await rm(path, { force: true });
    }
  }
  return { key: await readFile(leafKey), cert: await readFile(leafCert), caCertificatePath: caCert };
}
