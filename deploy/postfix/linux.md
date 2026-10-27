# Исходящая почта на Ubuntu 24.04

Это инструкция установки отдельной почтовой службы для `153.76.169.160`. Установка почтовых служб входит в прямое поручение автора. Инструкция описывает состав установки; сама по себе она не подтверждает выполнение на сервере. Публикация сайта, подключение почты к приложению и отправка настоящего письма — следующие отдельные шаги.

## Что устанавливаем

- Системные Postfix, OpenDKIM и инструменты проверки; Python 3. Node 24 уже должен находиться в `/opt/forma/node/bin/node`.
- Только нашу очередь `forma-postfix.service` и подписант `forma-dkim.service`. Входящих SMTP/IMAP/POP-служб нет. Порты 2525 и 8891 слушают исключительно `127.0.0.1`; наружу отправка идёт по TCP 25.
- Постоянная база `/var/lib/forma/forma.sqlite` и ключ `/var/lib/forma/keys/account-hmac.bin` создаются существующим владельцем данных из приложения, от пользователя `forma`. Схема вручную не дублируется. Это те же пути, что в `deploy/forma.service`.
- Настройки очереди — `/etc/forma-postfix`; её программы — `/var/lib/forma-postfix/libexec`; временные письма — `/var/spool/forma-postfix`.
- Настройки подписанта и ключ DKIM — `/etc/forma-dkim`, ключ читают только root и служба opendkim. Это не второй журнал писем. Подробные сырые логи служб отключены; результаты доставки позже принимает общий журнал приложения.

Пределы существующей очереди не меняются: 500 писем / 10 MiB, ожидание до 5 минут, очистка по общей почтовой политике. Не заполнять очередь искусственными письмами на этом этапе.

## 1. Собрать комплект на рабочем компьютере

В единственной рабочей папке проекта:

```sh
node deploy/postfix/package-linux.ts --output /private/tmp/forma-mail-linux
```

Получаются два самостоятельных служебных CLI, три существующих Python-файла, эта инструкция и SHA256SUMS. Нет сайта, `.env`, базы, ключей, истории Git или `node_modules`. Комплект нельзя выдавать за опубликованный релиз. Перед переносом согласовать актуальный снимок с 7а. При выполнении порученной установки передать этот каталог на сервер в `/var/tmp/forma-mail-linux`, сделать его владельцем `forma:forma`, сохранить закрытые права. Не переносить рабочую базу с Mac.

## 2. Установить пакеты, не включая стандартные почтовые службы

Все серверные блоки выполнять root в отдельной сессии с `set -eu`. Они рассчитаны на подтверждённое отсутствие прежнего Postfix/OpenDKIM. Если пакеты уже появились или существует чужой `policy-rc.d`, остановиться и проверить их владельца, не затирать.

```sh
set -eu
id forma
/opt/forma/node/bin/node -e 'if (+process.versions.node.split(".")[0] !== 24) process.exit(1)'
test -d /var/tmp/forma-mail-linux
cd /var/tmp/forma-mail-linux
sha256sum -c SHA256SUMS
test ! -e .env
for package in postfix opendkim; do
  if dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q 'install ok installed'; then
    echo "Already installed: $package; inspect before proceeding" >&2
    exit 1
  fi
done
test ! -e /usr/sbin/policy-rc.d
test ! -L /usr/sbin/policy-rc.d
(
  set -euC
  cat > /usr/sbin/policy-rc.d <<'POLICY'
#!/bin/sh
# Prevent package post-install scripts from starting mail listeners.
exit 101
POLICY
  trap 'rm -f /usr/sbin/policy-rc.d' EXIT
  chmod 0755 /usr/sbin/policy-rc.d
  printf '%s\n' 'postfix postfix/main_mailer_type select No configuration' | debconf-set-selections
  apt-get update
  DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l apt-get install -y postfix opendkim opendkim-tools python3 ca-certificates
)
systemctl mask postfix.service postfix@.service opendkim.service
```

Временный `policy-rc.d` запрещает автоматический запуск служб во время установки пакетов и удаляется по выходу из блока. Стандартные почтовые службы остаются замаскированы; работают только экземпляры Формы. Это не отключает `forma` или nginx.

## 3. Создать ключ DKIM и подписант

Повторно ключ не генерируем: смена ключа требует согласованной смены DNS. При уже существующем каталоге этот блок останавливается.

```sh
set -eu
test ! -e /etc/forma-dkim
test ! -L /etc/forma-dkim
test ! -e /etc/systemd/system/forma-dkim.service
install -d -o root -g opendkim -m 0750 /etc/forma-dkim
umask 0077
opendkim-genkey -b 2048 -s forma -d juxtaposition.ru -D /etc/forma-dkim
chown opendkim:opendkim /etc/forma-dkim/forma.private
chmod 0600 /etc/forma-dkim/forma.private
cat > /etc/forma-dkim/opendkim.conf <<'CONFIG'
Syslog no
SyslogSuccess no
LogWhy no
Background no
Mode s
Canonicalization relaxed/relaxed
SignatureAlgorithm rsa-sha256
Domain juxtaposition.ru
Selector forma
KeyFile /etc/forma-dkim/forma.private
InternalHosts 127.0.0.1
Socket inet:8891@[127.0.0.1]
OversignHeaders From
SendReports no
SoftwareHeader no
UMask 0077
CONFIG
chown root:opendkim /etc/forma-dkim/opendkim.conf
chmod 0640 /etc/forma-dkim/opendkim.conf
cat > /etc/systemd/system/forma-dkim.service <<'UNIT'
[Unit]
Description=Forma outgoing DKIM signer
After=network.target
[Service]
Type=simple
User=opendkim
Group=opendkim
ExecStart=/usr/sbin/opendkim -f -x /etc/forma-dkim/opendkim.conf
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
LogFilterPatterns=~.*
StandardOutput=null
StandardError=null
[Install]
WantedBy=multi-user.target
UNIT
chmod 0644 /etc/systemd/system/forma-dkim.service
runuser -u opendkim -- /usr/sbin/opendkim -n -x /etc/forma-dkim/opendkim.conf
systemctl daemon-reload
systemctl enable --now forma-dkim.service
systemctl is-active forma-dkim.service
```

Публичное значение находится в `/etc/forma-dkim/forma.txt`: его TXT-значение целиком переносится в DNS. `forma.private` никогда не печатать, не передавать в чат и не добавлять в комплект. Реальное значение `p=` появится только после создания ключа; заранее его выдумывать нельзя.

## 4. Создать постоянное хранилище и установить нашу очередь

Не менять существующую базу другого окружения. На первом запуске каталог `/var/lib/forma` отсутствует; если уже существует, предварительно проверить, что это принятый каталог текущей рабочей базы, с владельцем `forma` и правами 0700.

```sh
set -eu
install -d -o forma -g forma -m 0700 /var/lib/forma
runuser -u forma -- env -i PATH=/usr/bin:/bin FORMA_STATE_DIR=/var/lib/forma \
  FORMA_ACCOUNT_ORIGINS=https://forma.juxtaposition.ru \
  /opt/forma/node/bin/node /var/tmp/forma-mail-linux/deploy/prepare-accounts.mjs
runuser -u forma -- env -i PATH=/usr/bin:/bin FORMA_STATE_DIR=/var/lib/forma \
  /opt/forma/node/bin/node /var/tmp/forma-mail-linux/deploy/postfix/prepare.mjs \
  --output /var/tmp/forma-postfix-prepared --database /var/lib/forma/forma.sqlite --dkim-port 8891 --journal-socket /var/log/forma/run/services.sock
# Только IPv4: SPF/PTR согласованы для 153.76.169.160; IPv6 пока не подключён.
/usr/sbin/postconf -c /var/tmp/forma-postfix-prepared -e 'inet_protocols=ipv4'
# Защитить согласованный комплект от изменений непривилегированным процессом.
chown -R root:root /var/tmp/forma-postfix-prepared
chmod -R go-rwx /var/tmp/forma-postfix-prepared
python3 /var/tmp/forma-postfix-prepared/install.py --bundle /var/tmp/forma-postfix-prepared
# Просмотреть напечатанные пути; затем применить в рамках разрешённой установки.
python3 /var/tmp/forma-postfix-prepared/install.py --bundle /var/tmp/forma-postfix-prepared --apply
systemctl is-active forma-postfix.service
ss -ltnp
```

Подготовитель использует встроенные пути системного Postfix через `postconf -d`; отдельный `/etc/postfix/main.cf` для штатного экземпляра не требуется. Сам install.py пакеты ОС, DKIM, DNS и окружение приложения не меняет. Сайт продолжает обслуживать старый release; `forma.service` не перезапускаем и `/opt/forma/current` не переключаем.

Служебные ошибки отправляются в существующий общий журнал через закрытый сокет `FORMA_JOURNAL_DIR/run/services.sock` (0600). Установщик получает его полный путь явно через `--journal-socket`; для указанного выше пути в окружении нового приложения нужно `FORMA_JOURNAL_DIR=/var/log/forma`. Источники строго ограничены: подготовка летописи, подготовка индекса возвратов и управление почтовой очередью. Передаются только время, идентификатор события, источник и категория сбоя; тела писем, коды и вывод процессов не передаются. Одна попытка до секунды, без отдельной очереди и архива. Если приложение выключено, этот факт не сохраняется; причина остановки сайта после появления безопасного адреса журнала записывается самим запуском приложения.

Каталог `run` принадлежит одному владельцу и закрыт правами 0700. При работающем приложении нельзя вручную переименовывать, удалять или заменять `services.sock`: Node сам удаляет привязанный путь при закрытии сервера, и проверка файла после закрытия не может защитить чужую замену. Поддерживаемый переход — дождаться закрытия старого владельца, затем запускать нового. Повторный запуск при живом владельце отказывает; после аварии оставшийся неживой сокет проверяется и удаляется перед новым запуском.

## 5. DNS и PTR

Проверено с сервера 26 октября 2026: оба авторитетных NS Timeweb и резолвер 1.1.1.1 возвращают mail A, единственную SPF и DMARC из таблицы. DKIM опубликован и соответствует серверному ключу (`opendkim-testkey: key OK`). MX Timeweb и корневая A `92.53.96.223` сохранены. PTR изменён в FirstVDS на `mail.juxtaposition.ru` и подтверждён с VPS через 1.1.1.1 и 8.8.8.8; прямой A совпадает. Системный резолвер VPS при первой проверке ещё возвращал прежний кэш. Перед повторной настройкой перечитать записи; уже существующие не дублировать.

| Где | Имя | Что установить |
| --- | --- | --- |
| Timeweb DNS | `mail.juxtaposition.ru` A | `153.76.169.160` |
| Timeweb DNS | `juxtaposition.ru` TXT (единственная SPF-запись) | `v=spf1 ip4:153.76.169.160 include:_spf.timeweb.ru ~all` |
| Timeweb DNS | `forma._domainkey.juxtaposition.ru` TXT | Полное публичное значение из `forma.txt`, RSA 2048; без приватного ключа |
| Timeweb DNS | `_dmarc.juxtaposition.ru` TXT | `v=DMARC1; p=none` — начальный режим, без отправки отчётов на новый ящик |
| Панель провайдера VPS | PTR для `153.76.169.160` | `mail.juxtaposition.ru` — должен совпадать с прямым A и именем SMTP |

**Оставить:** все существующие NS, MX `10 mx1.timeweb.ru` / `10 mx2.timeweb.ru`, SPF-включение Timeweb и посторонние TXT/DKIM-записи. Не создавать вторую SPF-запись. Не добавлять AAAA, пока отдельный IPv6 не согласован. Адрес From `forma@juxtaposition.ru` уже задан кодом. Наличие этого From не создаёт ящик для ответов; входящие остаются у Timeweb, существование конкретного ящика отдельно не подтверждено.

Для исходящего SMTP используется STARTTLS чужого почтового сервера. Собственный сертификат Let's Encrypt для этого не нужен. Текущая настройка `smtp_tls_security_level=encrypt` запрещает незашифрованную передачу, но не проверяет соответствие имени сертификата чужого сервера; это не режим `verify`. Менять принятую политику TLS данным пакетом не предлагается. A/HTTPS для **сайта** `forma.juxtaposition.ru` — отдельная публикация, к установке отправителя не относится.

## 6. Приёмка до подключения и после него

Без письма: проверить права ключей, `opendkim -n`, наличие DKIM в `postconf -c /etc/forma-postfix -n`, оба systemd-сервиса, только loopback на 2525/8891, отсутствие нового входящего порта 25. `runuser -u opendkim -- opendkim-testkey -x /etc/forma-dkim/opendkim.conf -d juxtaposition.ru -s forma -k /etc/forma-dkim/forma.private` проверяет соответствие опубликованного ключа после обновления DNS; его вывод не должен включать приватный ключ. Без DNSSEC предупреждение о незащищённом DNS само по себе не означает несовпадение ключа. Проверить прямой A, PTR и единственную SPF-запись через независимый резолвер. Очередь должна оставаться пустой. Проверить отсутствие сырых почтовых данных в системных журналах после искусственной локальной проверки — до настоящих адресов.

На отдельном согласованном шаге 7а подключает приложение через `/etc/forma/environment`: `FORMA_STATE_DIR=/var/lib/forma`, `FORMA_POSTFIX_SOCKET=/var/lib/forma-postfix/run/control.sock`, `FORMA_POSTFIX_PORT=2525`, правильные публичные origins. Для подключения требуется новый релиз приложения и его журнал, это не делает почтовый установщик.

Затем одно разрешённое письмо по настоящему сценарию входа: получить его в целевом ящике, проверить SPF/DKIM/DMARC в заголовках и войти по коду. Ответ SMTP 250, работающая служба и локальные тесты отдельно не доказывают доставку во «Входящие». Проверить удаление тела из очереди и метаданные исхода в общем журнале. При отказе сохранять только разрешённые метаданные, без кода/тела/полного чужого ответа. После приёмки удалить временный установочный комплект и подготовленный каталог; постоянные база, ключи и очередь остаются на своих местах.

Фактическая проверка 26 октября 2026, 19:29:34 UTC: одно разрешённое письмо создано штатными `accounts.start → CodeMailQueue → Postfix` без публикации сайта. Gmail подтвердил SPF PASS, DKIM PASS (`forma`, `juxtaposition.ru`), DMARC PASS и TLS 1.3. Письмо попало в **спам**, поэтому доставка во «Входящие» не подтверждена; причина фильтра не установлена. Проверявший Gmail 7а переместил письмо в корзину. Тестовые попытка, почтовые метаданные, счётчики и нативная очередь удалены; аккаунт и сессия не создавались. Тело, код и адрес не передавались в журналы этой проверки. Проверка подтверждает внешнюю доставку, но не вход через публичный сайт: там оставлен прежний релиз.

По отдельной просьбе автора отправлено ещё одно письмо для просмотра: 19:34:28 UTC, штатный исход `mail_handed_off`. Полученное письмо в Gmail оставляем автору; тестовая попытка на сервере отменена, поэтому код из него не используется для входа в старую публичную версию. Повторные отправки после этих двух проверок не выполнялись.

Основания: [Postfix Milter](https://www.postfix.org/MILTER_README.html), [Postfix TLS](https://www.postfix.org/TLS_README.html), [OpenDKIM Ubuntu](https://manpages.ubuntu.com/manpages/noble/man5/opendkim.conf.5.html), [генератор ключа](https://manpages.ubuntu.com/manpages/noble/man8/opendkim-genkey.8.html).
