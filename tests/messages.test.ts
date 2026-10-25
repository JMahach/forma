import test from 'node:test';
import assert from 'node:assert/strict';
import { failureMessage, UI_MESSAGES } from '../src/ui/messages.ts';
test('general network failures have one phrase per cause across actions', () => {
  for (const code of ['offline','connection_failed']) assert.equal(failureMessage({code},'local fallback'),UI_MESSAGES.offline);
  assert.equal(failureMessage({code:'server_unavailable'},'local fallback'),UI_MESSAGES.serverUnavailable);
});
test('accepted context-specific wording is declared once, never guessed by a consumer', () => {
  assert.equal(failureMessage({code:'server_unavailable'},'fallback','day'),UI_MESSAGES.dayUnavailable);
  assert.equal(failureMessage({code:'offline'},'fallback','city'),'Нет соединения. Не можем найти город');
  assert.equal(failureMessage({code:'server_error'},'fallback','chart-form'),'Ошибка на сервере. Попробуйте позже');
  assert.equal(failureMessage({code:'server_unavailable'},'fallback','chart-form'),'Сервер не отвечает');
});
test('input and local-data failures are not rewritten as network failure', () => {
  assert.equal(failureMessage({code:'invalid_email',message:'internal'},UI_MESSAGES.emailInvalid),UI_MESSAGES.emailInvalid);
});

test('a received failure response is not described as server silence', () => {
  assert.equal(failureMessage({code:'server_error'},'local fallback'),UI_MESSAGES.serverError);
  assert.equal(failureMessage({code:'invalid_response'},UI_MESSAGES.lifetimeUnavailable),UI_MESSAGES.invalidResponse);
});

test('a completed busy response is distinct from an error and does not promise active waiting', () => {
  assert.equal(failureMessage({code:'busy',status:503},'fallback','chart-form'),UI_MESSAGES.calculationBusy);
  assert.equal(failureMessage({code:'engine_unavailable',status:503},'fallback','chart-form'),UI_MESSAGES.serverError);
});
