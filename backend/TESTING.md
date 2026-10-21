# Focused backend tests

Run a service or route file with one worker:

```sh
npm --prefix backend test -- --maxWorkers=1 --no-file-parallelism src/services/imapManager.retryReview.test.js
```

## PostgreSQL flag tests

The optional PostgreSQL suites require a local disposable PostgreSQL server.
Set `MAILFLOW_TEST_DATABASE_URL` to a disposable test database. The schema suite
creates and drops uniquely named schemas; the intent suite uses connection-local
temporary tables and sequences. The database user needs those privileges.

The JSON backup/restore case also needs `MAILFLOW_FLAG_BACKUP_TEST_DATABASE_URL`.
Create a separate, empty disposable database named `mailflow_flag_test_<suffix>`
on that server, owned by the test user. This case writes its fixtures into that
database's public schema and refuses any database name without that prefix.
Both variables must be set to run the backup/restore case.

```sh
createdb -h /path/to/test/socket -p 55432 mailflow_flag_test_main
createdb -h /path/to/test/socket -p 55432 mailflow_flag_test_backup
export MAILFLOW_TEST_DATABASE_URL='postgresql:///mailflow_flag_test_main?host=/path/to/test/socket&port=55432'
export MAILFLOW_FLAG_BACKUP_TEST_DATABASE_URL='postgresql:///mailflow_flag_test_backup?host=/path/to/test/socket&port=55432'
npm --prefix backend test -- --maxWorkers=1 --no-file-parallelism src/services/flagIntentSchema.postgres.test.js src/services/imapManager.flagIntent.postgres.test.js
```

Drop the disposable databases after the run. No provider connection or email
operation is involved.
