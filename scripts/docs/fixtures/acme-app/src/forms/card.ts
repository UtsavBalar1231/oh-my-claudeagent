export const card = {
  number: { pattern: /^\d{12,19}$/, error: "Check the card number" },
  expiry: { pattern: /^(0[1-9]|1[0-2])\/\d{2}$/, error: "Use MM/YY" },
  cvc: { pattern: /^\d{3,4}$/, error: "Enter the 3 or 4 digits on the back" },
};
