# Facturero — Bot de Facturación Electrónica Tipo C (Monotributista)

Genera facturas C en ARCA via Web Service (WSFE) sin pasar por ningún intermediario.

---

## Requisitos previos

- Node.js instalado
- OpenSSL instalado (`openssl --version` para verificar)
- CUIT de monotributista
- Acceso a ARCA con Clave Fiscal nivel 3

---

## Paso 1 — Generar clave privada y CSR en tu máquina

```bash
openssl genrsa -out key.key 2048

openssl req -new -key key.key -out request.csr \
  -subj "/C=AR/O=NOMBRE APELLIDO/CN=TU_CUIT/serialNumber=CUIT TU_CUIT"
```

Reemplazá `NOMBRE APELLIDO` y `TU_CUIT` con tus datos (CUIT sin guiones).

Esto genera dos archivos:
- `key.key` — clave privada. **Nunca la subas a ningún lado.**
- `request.csr` — pedido de certificado, este sí se sube a ARCA.

---

## Paso 2 — Obtener el certificado digital en ARCA

1. Entrá a **arca.gob.ar** con tu Clave Fiscal
2. Buscá **"Administración de Certificados Digitales"**
3. Clic en **"Agregar alias"**
4. Escribí un alias (ej: `facturero`)
5. Subí el archivo `request.csr`
6. Descargá el certificado que te genera ARCA (ej: `facturero_xxxxxxxx.crt`)
7. Guardá el `.crt` en la carpeta del proyecto

---

## Paso 3 — Vincular el certificado al servicio de Facturación Electrónica

1. En ARCA buscá **"Administrador de Relaciones de Clave Fiscal"**
2. Clic en **"Nueva Relación"**
3. Se abre un listado de organismos — clic en **"ARCA"**
4. Clic en **"WebServices"**
5. Del listado buscá **"Facturación Electrónica"** (no MTXCA, no exportación) y hacé clic
6. Se abre el formulario "Incorporar nueva Relación":
   - **Representado:** tu CUIT (ya viene seleccionado)
   - **Representante → BUSCAR:** buscá el alias que creaste (ej: `facturero`)
   - **Computador Fiscal:** seleccioná `facturero` del dropdown
   - Dejá el campo CUIT/Usuario vacío
7. Clic en **"Confirmar"**

Vas a ver el formulario F.3283/E con la autorización. Eso confirma que el certificado tiene permiso para usar wsfe.

---

## Paso 4 — Dar de alta el Punto de Venta tipo RECE

El portal manual de ARCA usa un punto de venta distinto al del web service. Hay que crear uno específico para el script.

1. En ARCA buscá **"ABM Puntos de Venta"**
2. Clic en **"Agregar"**
3. Completá:
   - **Número:** `2` (el `1` ya está ocupado por el portal manual)
   - **Nombre Fantasía:** dejar vacío
   - **Dominio Asociado:** dejar vacío
   - **Sistema:** `Factura Electronica - Monotributo - Web Services`
4. Clic en **"Aceptar"**

---

## Paso 5 — Instalar dependencias

```bash
npm install
```

---

## Paso 6 — Configurar el archivo `.env`

Copiá el archivo de ejemplo y completá con tus datos:

```bash
cp .env.example .env
```

Editá `.env`:

```env
CUIT=20000000000          # tu CUIT sin guiones
CERT=nombre.crt           # nombre del archivo .crt que descargaste de ARCA
KEY=key.key               # nombre de tu clave privada
PTO_VTA=2                 # número del punto de venta RECE que creaste
PRODUCTION=true           # false para pruebas (requiere cert de homologación)
```

> El `.env` está en `.gitignore` y nunca se sube al repo.

---

## Paso 7 — Emitir una factura

Editá el llamado al final de `index.js`:

```js
crearFacturaC({
  importeTotal: 10000.00,   // monto total a cobrar
  concepto: 2,              // 1=Productos 2=Servicios 3=Ambos
  docTipo: 99,              // 99=Consumidor Final 96=DNI 80=CUIT 86=CUIL
  docNro: 0,                // 0 si es consumidor final
  fechaInicio: '2026-04-01', // inicio del período facturado
  fechaFin:    '2026-04-30', // fin del período facturado (venc. pago = este mismo día)
}).catch(console.error);
```

```bash
node index.js
```

Resultado esperado:
```
✅ Factura C generada:
   Número:           2-00000001
   CAE:              86161935562555
   Vencimiento CAE:  20260427
```

---

## Paso 8 — Listar todas las facturas emitidas

En `index.js` comentá `crearFacturaC(...)` y descomentá:

```js
listarFacturas().catch(console.error);
```

```bash
node index.js
```

---

## Notas importantes

- **El CAE es la prueba legal de validez.** Sin CAE la factura no vale.
- **Vencimiento del CAE** es distinto al vencimiento de pago. El CAE vence 10 días después de la emisión — pero eso no invalida la factura, solo el período en que podés consultar el CAE online.
- **Las facturas del portal web (PtoVta 1) y las del script (PtoVta 2) son independientes.** No se ven entre sí en el portal, pero ambas son válidas ante ARCA.
- **Desde el 01/06/2026** el campo `CondicionIVAReceptorId` es obligatorio. Ya está incluido en el script con valor `5` (Consumidor Final).
- **Archivos que nunca deben subirse al repo:** `key.key`, `*.crt`, `*.csr` — ya están en el `.gitignore`.

---

## Estructura del proyecto

```
Facturero/
├── index.js                  # lógica principal: emitir y listar facturas
├── wsaa.js                   # autenticación con ARCA (token de sesión)
├── .env                      # configuración privada
├── .env.example              # plantilla de configuración
├── key.key                   # clave privada
├── facturero_xxxx.crt        # certificado de ARCA
├── request.csr               # CSR usado para obtener el certificado
├── .gitignore
└── package.json
```
