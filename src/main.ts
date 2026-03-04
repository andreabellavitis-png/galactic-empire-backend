import { NestFactory }      from '@nestjs/core';
import { ValidationPipe }   from '@nestjs/common';
import { AppModule }        from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const httpAdapter = app.getHttpAdapter();
  httpAdapter.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  app.enableCors({
    origin:      process.env.FRONTEND_URL ?? 'http://localhost:5173',
    credentials: true,
  });

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  const port = process.env.PORT ?? 4000;
  await app.listen(port);

  console.log(`
╔══════════════════════════════════════════╗
║   GALACTIC EMPIRE — Backend running      ║
║   http://localhost:${port}                 ║
╚══════════════════════════════════════════╝
  `);
}
bootstrap();
