/** Demo configuration only. Replace with approved EKT policy content when provided. */
export const purchasingPolicy = {
  payment: 'Оплата: подтверждённые способы и сроки оплаты не предоставлены.',
  delivery: 'Доставка: подтверждённые регионы, стоимость и сроки не предоставлены.',
  minimum: 'Минимальный заказ: подтверждённая сумма или количество не предоставлены.',
};
export function policyAnswer(message: string): string | null {
  const topics: string[] = [];
  if (/оплат|платеж|платёж|payment/i.test(message)) topics.push(purchasingPolicy.payment);
  if (/достав|delivery/i.test(message)) topics.push(purchasingPolicy.delivery);
  if (/минимальн|minimum order/i.test(message)) topics.push(purchasingPolicy.minimum);
  return topics.length ? `Демо-справка · условия требуют подтверждения\n${topics.join('\n')}\nУточните условия у EKT на ekt.kz. Оформление заказа и оплата в этом прототипе недоступны.` : null;
}
