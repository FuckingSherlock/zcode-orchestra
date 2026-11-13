# NOTICE — сторонний код

## src/vendor/captcha-happy.ts

Этот файл — дословная копия `src/proxy/captcha-happy.ts` из проекта
[TriDefender/zcode-api](https://github.com/TriDefender/zcode-api)
(ZCode Proxy, © 2026 TriDefender and the ZCode Proxy contributors),
захвачена из ветки `master` 2026-11-13.

Лицензия оригинала: **CC BY-NC-SA 4.0**
(https://creativecommons.org/licenses/by-nc-sa/4.0/).

Изменения относительно оригинала: только добавлен заголовок-атрибуция в начале
файла; исполняемый код не менялся.

Единственное назначение в этом проекте — разовое получение Aliyun captcha
verifyParam (traceless) для клейма бесплатных Start Plan кредитов Z.AI.
Использование некоммерческое (личный приватный инструмент).

Производные файлы (написаны с нуля для этого проекта, не являются копией):
`src/claim/mint.ts` (обёртка-ретраер над солвером), `src/claim/client.ts`,
`src/claim-cli.ts`, `src/claim.ts`.
