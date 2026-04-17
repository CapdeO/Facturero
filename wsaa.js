const soap = require('soap');
const forge = require('node-forge');
const fs = require('fs');

// URLs del servicio de autenticación de ARCA (WSAA)
// Homologación = ambiente de pruebas (requiere cert especial, no lo usamos)
// Producción   = ambiente real donde se generan los tickets de acceso válidos
const WSAA_WSDL_HOMO = 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms?wsdl';
const WSAA_WSDL_PROD = 'https://wsaa.afip.gov.ar/ws/services/LoginCms?wsdl';

// Construye el XML que le pedimos firmar a ARCA para obtener acceso
// "service" es el nombre del web service al que queremos acceder (ej: "wsfe")
// Convierte una fecha a string ISO con offset -03:00 (Argentina, sin DST)
// No se puede simplemente reemplazar la Z: hay que ajustar el valor de la hora también
function toArgISO(date) {
  const adjusted = new Date(date.getTime() - 3 * 60 * 60 * 1000); // UTC → UTC-3
  return adjusted.toISOString().replace(/\.\d+Z$/, '-03:00');
}

function buildTRA(service) {
  const now = new Date();

  // genTime: 1 minuto antes de ahora (margen por diferencia de relojes con el servidor de ARCA)
  const genTime = toArgISO(new Date(now.getTime() - 60000));

  // expTime: el ticket expira en 10 minutos desde ahora
  const expTime = toArgISO(new Date(now.getTime() + 60000 * 10));

  // uniqueId: número único para evitar que ARCA rechace tickets duplicados
  const uniqueId = Math.floor(now.getTime() / 1000);

  return `<?xml version="1.0" encoding="UTF-8"?>
<loginTicketRequest version="1.0">
  <header>
    <uniqueId>${uniqueId}</uniqueId>
    <generationTime>${genTime}</generationTime>
    <expirationTime>${expTime}</expirationTime>
  </header>
  <service>${service}</service>
</loginTicketRequest>`;
}

// Firma el XML (TRA) con nuestra clave privada y certificado usando el estándar PKCS#7
// ARCA verifica esta firma para confirmar que somos nosotros
function signTRA(tra, certPath, keyPath) {
  const certPem = fs.readFileSync(certPath, 'utf8'); // certificado .crt de ARCA
  const keyPem = fs.readFileSync(keyPath, 'utf8');   // clave privada .key generada localmente

  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(tra, 'utf8'); // el XML que firmamos
  p7.addCertificate(certPem);
  p7.addSigner({
    key: forge.pki.privateKeyFromPem(keyPem),
    certificate: forge.pki.certificateFromPem(certPem),
    digestAlgorithm: forge.pki.oids.sha256, // algoritmo de hash SHA-256
    authenticatedAttributes: [],
  });
  p7.sign({ detached: false });

  // Convertimos la firma a base64 para enviársela a ARCA por SOAP
  const der = forge.asn1.toDer(p7.toAsn1()).getBytes();
  return Buffer.from(der, 'binary').toString('base64');
}

// Extrae el token y sign de la respuesta XML de ARCA
// Estos dos valores se usan en cada llamada a WSFE para identificarnos
function parseTA(response) {
  const xml = response.loginCmsReturn;
  const token = xml.match(/<token>(.*?)<\/token>/)[1]; // token de sesión
  const sign  = xml.match(/<sign>(.*?)<\/sign>/)[1];   // firma de sesión
  return { token, sign };
}

// Función principal: hace todo el flujo de autenticación y devuelve { token, sign }
async function getTA(service, certPath, keyPath, production = false) {
  const wsdl = production ? WSAA_WSDL_PROD : WSAA_WSDL_HOMO;
  const tra = buildTRA(service);          // 1. construye el XML
  const cms = signTRA(tra, certPath, keyPath); // 2. lo firma

  const client = await soap.createClientAsync(wsdl);
  const [result] = await client.loginCmsAsync({ in0: cms }); // 3. lo envía a ARCA
  return parseTA(result);                 // 4. extrae y devuelve token+sign
}

module.exports = { getTA };
