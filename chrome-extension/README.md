# Painel Fiscal — Extensão Chrome

Substitui o bookmarklet ⚡ Monitor por uma extensão Manifest V3 que injeta o monitor automaticamente em todas as abas do TecConcursos.

## Instalação (modo desenvolvedor)

1. Abra o Chrome e acesse `chrome://extensions`
2. Ative **"Modo do desenvolvedor"** (canto superior direito)
3. Clique em **"Carregar sem compactação"**
4. Selecione a pasta `chrome-extension/` deste repositório
5. Pronto! O ícone ⚡ aparecerá na barra de ferramentas

## Como usar

- Abra o [Painel Fiscal](https://cazuzaleo89-netizen.github.io/projetofiscal/) em uma aba
- Abra qualquer caderno no TecConcursos em outra aba
- O monitor injeta automaticamente — você verá o widget ⚡ no canto inferior direito do TEC
- Resolva questões normalmente; acertos/erros, cronômetro e fila de revisão sincronizam em tempo real

## Diferenças em relação ao bookmarklet

| Recurso | Bookmarklet | Extensão |
|---------|------------|----------|
| Ativação | Clique manual na barra de favoritos | Automático em toda aba TEC |
| Sobrevive a recarregar | Não (reinjetar) | Sim |
| Badge com revisões | Não | Sim (ícone da extensão) |
| Notificações desktop | Não | Sim |
| Popup com stats | Não | Sim |

## O bookmarklet continua funcionando

O bookmarklet ⚡ Monitor ainda está disponível no Painel Fiscal para quem preferir não instalar a extensão.

## Permissões solicitadas

- `storage` — salva configurações locais
- `notifications` — alertas de revisão pendente
- `tabs` — localiza abas do painel e do TEC para relay de mensagens
- `activeTab` — interage com a aba ativa quando necessário
