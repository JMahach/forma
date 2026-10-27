/** Shared words for an existing cause. Presentation and request policy have separate owners. */
export const UI_MESSAGES = {
  offline: 'Нет соединения', serverUnavailable: 'Сервер не отвечает', connectionFailed: 'Нет связи с сервером',
  serverError: 'Ошибка на сервере. Попробуйте позже', invalidResponse: 'Не удалось получить ответ сервера',
  dayLoading: 'Загружаем день…', dayPreparing: 'Рассчитываем день…', dayUnavailable: 'День не загружен: нет связи с сервером',
  lifetimeLoading: 'Загружаем летопись…', lifetimeUnavailable: 'Не удалось загрузить летопись', momentLoading: 'Загружаем момент…', momentUnavailable: 'Не удалось загрузить момент',
  returnsLoading: 'Загружаем возвраты…', returnUnavailable: 'Не удалось открыть карту возврата',
  chartLoading: 'Загружаем карту…', chartUnavailable: 'Не удалось загрузить карту',
  accountUnavailable: 'Не удалось загрузить аккаунт.', chartDeleteFailed: 'Не удалось удалить карту. Она осталась в библиотеке.',
  accountActionFailed: 'Не удалось выполнить действие. Попробуйте ещё раз.',
  cityLookupFailed: 'Нет соединения. Не можем найти город', chartCalculationFailed: 'Не удалось подготовить карту',
  chartSaveChecking: 'Проверяем сохранение…', chartDeleting: 'Удаляем карту…',
  chartSaveFailed: 'Не удалось сохранить карту', chartSaveUnconfirmed: 'Сохранение пока не подтверждено',
  chartSaveSignIn: 'Войдите снова, чтобы сохранить карту',
  linkCopied: 'Ссылка скопирована', linkCopyFailed: 'Не удалось скопировать ссылку',
  calculationBusy: 'Сервер занят', chartPreparing: 'Готовим карту…', chartSaving: 'Сохраняем карту…', retry: 'Повторить',
  emailRequired: 'Введите адрес почты', emailInvalid: 'Проверьте адрес почты',
  codeEmailHint: 'Если письмо не пришло, проверьте папку «Спам».',
  codeInvalid: 'Неверный код', codeExpired: 'Срок кода истёк', attemptExpired: 'Время для входа истекло. Начните заново',
  authRateLimited: 'Слишком много попыток. Попробуйте позже.', codeSendFailed: 'Не удалось отправить код',
  codeDeliveryFailed: 'Не удалось доставить письмо', codeVerifyFailed: 'Не удалось проверить код',
  telegramConflict: 'Этот Telegram уже связан с другим аккаунтом.', authOpening: 'Открываем вход…',
  authSending: 'Отправляем код…', authVerifying: 'Проверяем код…', authTelegram: 'Ожидаем подтверждение Telegram…', accountLoading: 'Загружаем аккаунт…',
} as const;
export type FailureContext = 'default' | 'city' | 'day' | 'chart-form';
export function failureMessage(error: unknown, fallback: string, context: FailureContext = 'default'): string {
  const problem = typeof error === 'object' && error ? error as {code?: unknown; status?: unknown} : null;
  const code = problem?.code;
  // Waiting/continuation belongs to the calculation owner, not HTTP or this catalog.
  if (context === 'chart-form' && code === 'busy') return UI_MESSAGES.calculationBusy;
  const serverFailure = typeof problem?.status === 'number' && problem.status >= 500 || ['server_error', 'busy', 'engine_unavailable'].includes(String(code));
  const knownFailure = serverFailure || ['offline', 'connection_failed', 'server_unavailable', 'invalid_response'].includes(String(code));
  if (!knownFailure) return fallback;
  if (context === 'day') return UI_MESSAGES.dayUnavailable;
  if (context === 'city') return UI_MESSAGES.cityLookupFailed;
  if (serverFailure) return UI_MESSAGES.serverError;
  if (code === 'invalid_response') return UI_MESSAGES.invalidResponse;
  return code === 'offline' || code === 'connection_failed' ? UI_MESSAGES.offline : UI_MESSAGES.serverUnavailable;
}
