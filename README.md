# Coordenação EAC — demandas e votações

App web para a coordenação registrar demandas, abrir votações e saber, de relance, quem já deu o retorno e quem ainda precisa dar.

- **8 usuários fixos** (os 4 tios e os 4 jovens)
- **Login com nome + PIN de 4 dígitos** (criado na primeira entrada)
- **Cada demanda tem 2, 3, 4 ou N opções de voto**
- **Prazo obrigatório**, com selo colorido de urgência:
  - 🟢 **Verde** — mais de 3 dias
  - 🟡 **Amarelo** — entre 1 e 3 dias (atenção)
  - 🔴 **Vermelho** — menos de 24h ou vencida (gritando)
- **Votação aberta até o prazo.** Acabou o prazo, a maioria venceu.
- Voto pode ser mudado até o encerramento.
- Só quem criou edita ou exclui.
- **Tempo real** — todo mundo vê atualizações na hora.
- **Mobile-first** e leve (HTML + Tailwind + JS puro, sem build step).

---

## 🚀 Passo a passo para publicar

### 1. Criar o projeto no Firebase (plano Spark — grátis)

1. Abra **https://console.firebase.google.com** e clique **Adicionar projeto**.
2. Dê um nome (ex: `eac-coordenacao`), siga os passos. Pode **desativar** Google Analytics.
3. Dentro do projeto, no menu lateral:
   - **Build → Authentication → Get started → aba "Sign-in method"** → clique em **Anônimo** → **Ativar** → Salvar.
   - **Build → Firestore Database → Criar banco de dados** → escolha região **`southamerica-east1` (São Paulo)** → modo **produção** → Ativar.

### 2. Colocar as regras de segurança

Em **Firestore Database → aba "Regras"**, apague o que tem e cole o conteúdo do arquivo **`firestore.rules`** deste projeto. Clique **Publicar**.

### 3. Copiar as credenciais para o código

1. No Firebase, clique na engrenagem ⚙️ ao lado de "Visão geral do projeto" → **Configurações do projeto**.
2. Role até **Seus apps** → clique no ícone **`</>`** (Web) → dê um apelido (ex: `eac-web`) → **Registrar app** (não precisa marcar Hosting).
3. Aparece um objeto `firebaseConfig = { apiKey: "...", ... }`. **Copie ele inteiro.**
4. Abra o arquivo **`firebase-config.js`** deste projeto e **cole no lugar do placeholder** (linhas 13–20).

### 4. Publicar no GitHub Pages

1. Crie um repositório novo no GitHub (pode ser público ou privado).
2. Faça upload dos 4 arquivos: `index.html`, `app.js`, `firebase-config.js`, `README.md`.
   - (Pelo navegador mesmo: **Add file → Upload files** → arrastar → Commit.)
3. No repositório, vá em **Settings → Pages**.
4. Em **Source**, escolha **Deploy from a branch** → **Branch: `main`** (ou `master`), pasta `/ (root)` → **Save**.
5. Aguarde ~1 minuto. A URL aparece no topo (algo como `https://seu-usuario.github.io/nome-do-repo/`).

### 5. Autorizar o domínio no Firebase

1. Volte no Firebase → **Authentication → Settings (aba) → Authorized domains** → **Add domain** → cole o domínio do GitHub Pages (ex: `seu-usuario.github.io`) → Add.
2. Pronto. Agora é só mandar a URL pro grupo.

### 6. Primeiro acesso de cada pessoa

- Cada coordenador abre o link, **escolhe o próprio nome**, e é convidado a **criar um PIN de 4 dígitos**.
- Esse PIN vale só para o login dessa pessoa. Pode ser trocado depois (avatar no canto → "Trocar meu PIN").

---

## 💡 Como usar

- Toque no **`+`** (canto inferior direito) para **cadastrar uma demanda**.
  - Informe título, contexto opcional, **prazo** e **pelo menos 2 opções de voto** (pode ter até 8).
- Cada card no feed mostra: urgência, tempo restante, quem já votou e quem falta.
- Toque num card para **ver detalhes, votar** (ou trocar o voto) e ver quem está faltando.
- Se você criou a demanda, aparecem os botões **Editar** e **Excluir** no final.
- Use o filtro **"Aguardam meu voto"** para ver só o que depende de você.

---

## 🔐 Sobre a segurança

Este app usa **Firebase Anonymous Auth** — todo mundo que abre o link entra como "autenticado" aos olhos do Firestore, e então valida o PIN do próprio nome.

Isso significa duas coisas:

1. **A URL deve ficar só com os 8.** Não é um app público. Se alguém de fora tiver o link e souber o nome e o PIN de algum coordenador, consegue entrar como ele. Mesma lógica de um grupo privado.
2. **Dentro dos 8, o modelo é de confiança mútua.** Qualquer um autenticado conseguiria, tecnicamente, mexer direto no banco. Mas a interface só permite cada um editar/excluir o que criou, e o PIN individualiza a identidade.

Para a coordenação de 8 pessoas que já se conhecem, essa segurança é mais que suficiente. Se um dia quiser endurecer, dá pra migrar para login com e-mail + senha do Firebase Auth e regras mais estritas — mas aí perde a simplicidade do PIN.

---

## 🛠️ Problemas comuns

**"Não foi possível conectar ao Firebase"**
→ Você esqueceu de colar o `firebaseConfig` no `firebase-config.js`, ou o Anonymous Auth não está ativo.

**"Missing or insufficient permissions"**
→ As regras do Firestore não foram publicadas. Refaça o passo 2.

**Alguém esqueceu o PIN**
→ Vá no Firebase → Firestore → coleção `users` → abra o doc da pessoa → apague o campo `pinHash`. Da próxima vez que ela logar, ela cria um novo.

**Quero remover o GitHub Pages depois**
→ Settings → Pages → Source → None. O link cai na hora.

---

## 📐 Arquitetura em uma linha

`index.html` (shell + estilos) + `app.js` (estado + renderização + Firestore realtime) + `firebase-config.js` (credenciais) + `firestore.rules` (regras do banco). Sem build, sem npm, sem servidor — só estático no GitHub Pages falando com Firestore via SDK oficial.

---

## 📊 Plano Spark — cabe tranquilo

Com 8 usuários e ~20 demandas por semana:
- Leituras: ~2.000/dia (limite 50.000) ✅
- Escritas: ~100/dia (limite 20.000) ✅
- Armazenamento: < 1 MB (limite 1 GB) ✅

Nem chega perto do limite grátis.
