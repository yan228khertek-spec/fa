import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();

// Без DATABASE_URL каталог и журнал живут в памяти процесса. Для dev это
// удобно, в проде — fail-open: забытая переменная окружения даст 1С `success`
// на выгрузке, которая исчезнет при рестарте (ревью этапа 2, находка 8).
if (!config.databaseUrl) {
  if (process.env.NODE_ENV === 'production') {
    process.stderr.write('DATABASE_URL обязателен в production: каталог некуда сохранять\n');
    process.exit(1);
  }
  process.stderr.write('ВНИМАНИЕ: DATABASE_URL не задан — каталог и журнал только в памяти\n');
}

const app = await buildApp({ config });

app.listen({ port: config.port, host: config.host }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
