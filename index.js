require('dotenv').config();
const soap = require('soap');
const path = require('path');
const { getTA } = require('./wsaa');

// URLs del servicio de facturación electrónica de ARCA (WSFE)
const WSFE_WSDL_HOMO = 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx?wsdl';
const WSFE_WSDL_PROD = 'https://servicios1.afip.gov.ar/wsfev1/service.asmx?wsdl';

const CUIT       = Number(process.env.CUIT);
const CERT       = path.join(__dirname, process.env.CERT);
const KEY        = path.join(__dirname, process.env.KEY);
const PTO_VTA    = Number(process.env.PTO_VTA);
const PRODUCTION = process.env.PRODUCTION === 'true';

// ─── Valores posibles para cada campo ────────────────────────────────────────
//
// concepto (qué estás facturando):
//   1 = Productos
//   2 = Servicios          ← lo más común para monotributistas
//   3 = Productos y Servicios
//
// docTipo (tipo de documento del cliente):
//   99 = Consumidor Final  ← cuando el cliente no te da datos (hasta $10.000.000, RG 5700/2025)
//   96 = DNI
//   80 = CUIT
//   86 = CUIL
//
//   Si docTipo = 99, docNro debe ser 0
//   Si docTipo = 96/80/86, docNro es el número real del cliente
//
// ─────────────────────────────────────────────────────────────────────────────

// fechaInicio y fechaFin en formato 'YYYY-MM-DD', ej: '2026-04-01'
async function crearFacturaC({ importeTotal, concepto = 2, docTipo = 99, docNro = 0, fechaInicio, fechaFin }) {
  const wsdl = PRODUCTION ? WSFE_WSDL_PROD : WSFE_WSDL_HOMO;

  // Paso 1: autenticarse con ARCA y obtener token+sign válidos para esta sesión
  const { token, sign } = await getTA('wsfe', CERT, KEY, PRODUCTION);

  const client = await soap.createClientAsync(wsdl);

  // El objeto auth va en cada llamada a WSFE para que ARCA sepa quién somos
  const auth = { Token: token, Sign: sign, Cuit: CUIT };

  // Paso 2: consultar cuál fue el último número de comprobante emitido
  // Así sabemos qué número corresponde al próximo (no puede haber saltos ni repeticiones)
  const [lastRes] = await client.FECompUltimoAutorizadoAsync({
    Auth: auth,
    PtoVta: PTO_VTA,      // punto de venta (el que configuraste en ARCA, generalmente 1)
    CbteTipo: 11,   // tipo de comprobante: 11 = Factura C (la de monotributistas)
  });
  const ultimo = lastRes.FECompUltimoAutorizadoResult.CbteNro;
  const nro = ultimo + 1; // número del nuevo comprobante

  // Fecha de emisión en formato YYYYMMDD que requiere ARCA
  const fecha = new Date().toISOString().slice(0, 10).replace(/-/g, '');

  // Fechas del período de servicio (requeridas cuando Concepto = 2 o 3)
  const fchDesde  = fechaInicio.replace(/-/g, ''); // 'YYYY-MM-DD' → 'YYYYMMDD'
  const fchHasta  = fechaFin.replace(/-/g, '');    // ídem
  // vencimiento = fin de servicio, pero no puede ser anterior a la fecha de emisión
  const fchVtoPago = fchHasta >= fecha ? fchHasta : fecha;

  // Paso 3: solicitar el CAE (Código de Autorización Electrónico) a ARCA
  // Sin CAE la factura no es válida legalmente
  const [result] = await client.FECAESolicitarAsync({
    Auth: auth,
    FeCAEReq: {

      // Cabecera: datos generales del lote de comprobantes
      FeCabReq: {
        CantReg: 1,      // cantidad de facturas en este envío (mandamos de a 1)
        PtoVta: PTO_VTA,       // punto de venta
        CbteTipo: 11,    // 11 = Factura C
      },

      // Detalle: datos de cada factura (acá solo hay una)
      FeDetReq: {
        FECAEDetRequest: {
          Concepto: concepto, // 1=Productos 2=Servicios 3=Ambos
          DocTipo: docTipo,   // 99=Cons.Final 96=DNI 80=CUIT 86=CUIL
          DocNro: docNro,     // 0 si es consumidor final, sino el número del doc

          // CbteDesde y CbteHasta son iguales cuando emitimos una sola factura
          CbteDesde: nro,
          CbteHasta: nro,

          CbteFch: fecha, // fecha de emisión YYYYMMDD

          // Importes — como monotributista no cobrás IVA, todo va en ImpNeto
          ImpTotal: importeTotal,  // total que cobra el cliente
          ImpTotConc: 0,           // importe no gravado (0 para monotributistas)
          ImpNeto: importeTotal,   // base imponible (igual al total para monotributistas)
          ImpOpEx: 0,              // operaciones exentas (0 para monotributistas)
          ImpIVA: 0,               // IVA = 0 (los monotributistas no discriminan IVA)
          ImpTrib: 0,              // otros tributos (percepciones, etc.) = 0

          FchServDesde: fchDesde,   // inicio del período facturado YYYYMMDD
          FchServHasta: fchHasta,   // fin del período facturado YYYYMMDD
          FchVtoPago:   fchVtoPago, // vencimiento de pago YYYYMMDD

          CondicionIVAReceptorId: 5, // 5 = Consumidor Final (obligatorio desde 01/06/2026)

          MonId: 'PES',   // moneda: PES=Pesos, DOL=Dólares, etc.
          MonCotiz: 1,    // cotización (1 para pesos, tipo de cambio para otras monedas)
        },
      },
    },
  });

  const res = result.FECAESolicitarResult;

  // Errores a nivel cabecera (problema con auth, punto de venta, etc.)
  if (res.Errors?.Err) {
    const errs = [].concat(res.Errors.Err).map(e => `[${e.Code}] ${e.Msg}`).join(', ');
    throw new Error(`Error de cabecera: ${errs}`);
  }

  const det = [].concat(res.FeDetResp.FECAEDetResponse)[0];

  // Resultado puede ser:
  //   'A' = Aprobado ✅
  //   'R' = Rechazado ❌ (con observaciones que explican el motivo)
  //   'P' = Parcial  ⚠️ (algunos comprobantes aprobados y otros no, solo pasa en lotes)
  if (det.Resultado !== 'A') {
    const obs = det.Observaciones?.Obs
      ? [].concat(det.Observaciones.Obs).map(o => `[${o.Code}] ${o.Msg}`).join(', ')
      : 'sin detalle';
    throw new Error(`ARCA rechazó la factura: ${obs}`);
  }

  console.log('✅ Factura C generada:');
  console.log(`   Número:           ${1}-${nro}`);
  console.log(`   CAE:              ${det.CAE}`);
  console.log(`   Vencimiento CAE:  ${det.CAEFchVto}`); // el CAE vence, no la factura

  return { nro, cae: det.CAE, vencimientoCAE: det.CAEFchVto };
}

async function listarFacturas() {
  const wsdl = PRODUCTION ? WSFE_WSDL_PROD : WSFE_WSDL_HOMO;
  const { token, sign } = await getTA('wsfe', CERT, KEY, PRODUCTION);
  const client = await soap.createClientAsync(wsdl);
  const auth = { Token: token, Sign: sign, Cuit: CUIT };

  const [lastRes] = await client.FECompUltimoAutorizadoAsync({ Auth: auth, PtoVta: PTO_VTA, CbteTipo: 11 });
  const ultimo = lastRes.FECompUltimoAutorizadoResult.CbteNro;

  if (ultimo === 0) { console.log('Sin comprobantes emitidos.'); return; }

  for (let nro = 1; nro <= ultimo; nro++) {
    const [res] = await client.FECompConsultarAsync({
      Auth: auth,
      FeCompConsReq: { CbteTipo: 11, CbteNro: nro, PtoVta: PTO_VTA },
    });
    const f = res.FECompConsultarResult.ResultGet;
    console.log(`
  Factura:           ${f.PtoVta}-${String(f.CbteDesde).padStart(8,'0')}
  Fecha emisión:     ${f.CbteFch}
  Período desde:     ${f.FchServDesde}
  Período hasta:     ${f.FchServHasta}
  Venc. pago:        ${f.FchVtoPago}
  Importe total:     $${f.ImpTotal}
  Importe neto:      $${f.ImpNeto}
  IVA:               $${f.ImpIVA}
  Doc. receptor:     tipo ${f.DocTipo} / nro ${f.DocNro}
  Concepto:          ${f.Concepto === 1 ? 'Productos' : f.Concepto === 2 ? 'Servicios' : 'Productos y Servicios'}
  Moneda:            ${f.MonId} (cotiz: ${f.MonCotiz})
  CAE:               ${f.CodAutorizacion}
  Tipo emisión:      ${f.EmisionTipo}
  Venc. CAE:         ${f.FchVto}
  Fecha proceso:     ${f.FchProceso}
  ${'─'.repeat(50)}`);
  }
}

listarFacturas().catch(console.error);

// crearFacturaC({
//   importeTotal: 10000.00,
//   concepto: 2,
//   docTipo: 99,
//   docNro: 0,
//   fechaInicio: '2026-04-01',
//   fechaFin:    '2026-04-30',
// }).catch(console.error);
