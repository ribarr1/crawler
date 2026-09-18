Instalar
--------

Abrir power shell como administrador y ejecutar: Set-ExecutionPolicy RemoteSigned

node -v
npm -v

npm install

npm list playwright // Valida que este instalado
npm init -y
npm i -D playwright
npx playwright install chromium 

Comandos
--------
### Ejecución con autenticación:

Las credenciales deben existir únicamente en el archivo `.env` local o como variables de entorno. No las escribas en este archivo ni las subas al repositorio. El `.env` debe usar formato `NOMBRE=VALOR`.

- Alternativamente, pueden fijarse en la terminal antes de ejecutar:
$env:NAVEGA_USER="<usuario-qa>"
$env:NAVEGA_PASSWORD="<clave-qa>"

- crawl
npm run crawl:qa
- execute
npm run execute:qa

Cada corrida QA crea carpetas nuevas con fecha y hora. `execute:qa` utiliza automáticamente la última corrida generada por `crawl:qa`.

Para recorrer QA por módulos, renovando la sesión en cada módulo y entrando a cada módulo mediante el enlace del home (evita errores de URL directa):
npm run qa:modules

El flujo modular procesa Usuarios, Vinculación, LEO, Operadores y Promotores y Operaciones. Cada módulo conserva su propio inventario, evidencias y reportes. Puedes limitar páginas por módulo con `$env:NAVEGA_MODULE_MAX_PAGES="100"`.


### Ejecución sin autenticación
- crawl
npm run crawl:public
- execute
npm run execute:public

Cada corrida pública crea carpetas nuevas con fecha y hora. `execute:public` utiliza automáticamente la última corrida generada por `crawl:public`.

Para ver el navegador durante la ejecución pública:
npm run execute:public:visible

### Compare QA vs PROD
-------
npm run compare

