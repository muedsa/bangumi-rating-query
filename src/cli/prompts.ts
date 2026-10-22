import * as clack from '@clack/prompts';
import type { Presentation } from './presentation.ts';
import { CliCancelled } from './cancellation.ts';
import { display } from './display.ts';

export interface Choice<T> {
  value: T;
  label: string;
  hint?: string;
}
export interface TextQuestion {
  message: string;
  defaultValue?: string;
  validate?: (value: string) => string | undefined;
}
export interface Prompts {
  select<T extends string | number>(
    message: string,
    choices: Choice<T>[],
    initialValue?: T,
  ): Promise<T>;
  text(question: TextQuestion): Promise<string>;
  file(question: TextQuestion): Promise<string>;
  confirm(message: string, initialValue?: boolean): Promise<boolean>;
}
export function createPrompts(presentation: Presentation, controller: AbortController): Prompts {
  const common = { output: presentation.output, input: process.stdin };
  async function ask<T>(run: (signal: AbortSignal) => Promise<T | symbol>): Promise<T> {
    presentation.setWaiting(true);
    // Clack 不会移除已完成提示的 signal 监听；仅向当前提示转发取消。
    const promptController = new AbortController();
    const abort = () => promptController.abort();
    controller.signal.addEventListener('abort', abort, { once: true });
    if (controller.signal.aborted) abort();
    try {
      let value: T | symbol;
      try {
        value = await run(promptController.signal);
      } finally {
        controller.signal.removeEventListener('abort', abort);
      }
      if (clack.isCancel(value)) {
        controller.abort();
        throw new CliCancelled();
      }
      return value as T;
    } finally {
      presentation.setWaiting(false);
    }
  }
  return {
    select: <T extends string | number>(message: string, choices: Choice<T>[], initialValue?: T) =>
      ask<T>((signal) =>
        clack.select<T>({
          ...common,
          signal,
          message: `${message}（↑↓ 选择，Enter 确认）`,
          options: choices.map((choice) => ({
            ...choice,
            label: display(choice.label),
            hint: choice.hint ? presentation.selectionHint(choice.hint) : undefined,
          })) as clack.SelectOptions<T>['options'],
          initialValue,
          maxItems: 10,
          showInstructions: false,
        }),
      ),
    text: (question) =>
      ask<string>((signal) =>
        clack.text({
          ...common,
          signal,
          ...question,
          placeholder: question.defaultValue,
          validate: (value) => question.validate?.(value ?? question.defaultValue ?? ''),
        }),
      ),
    file: (question) =>
      ask<string>((signal) =>
        clack.path({
          ...common,
          signal,
          ...question,
          initialValue: question.defaultValue,
          validate: (value) => question.validate?.(value ?? ''),
        }),
      ),
    confirm: (message, initialValue = false) =>
      ask<boolean>((signal) =>
        clack.confirm({ ...common, signal, message, initialValue, active: '是', inactive: '否' }),
      ),
  };
}
