// Words of the early-access form (the top page, en and ja). Japanese is written first; English follows.
// The form posts to site/edge/signup.mjs; each state below is what its answer means.

export const STRINGS = {
  ja: {
    email: "メールアドレス",
    role: "立場",
    roles: { site: "サイトを運営している", agent: "AI エージェントを作っている", other: "その他" },
    site: "サイトかエージェントの URL（任意）",
    submit: "先行登録する",
    note: "入力された内容は Ludion のチームに届き、Ludion についてのご連絡に使います。",
    states: {
      sending: "送信しています…",
      done: "受け付けました。ありがとうございます。",
      invalid: "メールアドレスを確かめてください。",
      limited: "この端末からの送信が続いています。しばらくしてから、もう一度お試しください。",
      error: "送信できませんでした。しばらくしてから、もう一度お試しください。",
    },
  },
  en: {
    email: "Email",
    role: "Role",
    roles: { site: "I run a site", agent: "I build an AI agent", other: "Something else" },
    site: "Site or agent URL (optional)",
    submit: "Request early access",
    note: "What you enter is sent to the Ludion team and used to contact you about Ludion.",
    states: {
      sending: "Sending…",
      done: "Received. Thank you.",
      invalid: "Please check the email address.",
      limited: "Too many attempts from here. Please try again later.",
      error: "It could not be sent. Please try again later.",
    },
  },
};
