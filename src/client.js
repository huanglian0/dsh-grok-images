// DSH 0.2.1 native Conversation projection + official image gallery.
// Replays existing successful Grok tool records; never scans prose or local files.
window.__ModuleLoader__.load({
  id: 'dsh-plugin-grok-imagine',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const KEY = 'grok-imagine-images'
    const TOOLS = new Set(['grok_image_generate', 'grok_image_edit'])
    function imageRef(value) {
      return value && /^sha256:[a-f0-9]{64}$/.test(value.attachmentId) &&
        ['image/png', 'image/jpeg', 'image/webp'].includes(value.mediaType) &&
        Number.isSafeInteger(value.width) && value.width > 0 &&
        Number.isSafeInteger(value.height) && value.height > 0 &&
        Number.isSafeInteger(value.bytes) && value.bytes > 0
    }
    function createDefinition() {
      return {
        kind: KEY,
        match(event) {
          if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
          if (event.type === 'tool/call' || (event.type === 'tool/result' && event.surfaceOp === 'append')) return { id: String(event.data.turn), role: 'update' }
          return null
        },
        start(_context, match) { return { turn: match.event.data.turn, calls: new Map(), images: [], settled: new Set() } },
        update(context, match) {
          const state = context.state, event = match.event
          if (event.type === 'tool/call') {
            if (!TOOLS.has(event.data.name)) return state
            const calls = new Map(state.calls)
            calls.set(String(event.data.callId), event.data.name)
            return { ...state, calls }
          }
          if (event.type !== 'tool/result' || event.surfaceOp !== 'append') return state
          const message = event.data.message, callId = String(message?.source?.callId)
          if (!state.calls.has(callId) || state.settled.has(callId) || message?.isError === true || !Array.isArray(message?.content)) return state
          const seen = new Set(), images = []
          for (const block of message.content) {
            if (block.type !== 'image' || !imageRef(block.attachment) || seen.has(block.attachment.attachmentId)) continue
            seen.add(block.attachment.attachmentId)
            images.push({ seq: event.seq, callId, operation: state.calls.get(callId) === 'grok_image_edit' ? 'edit' : 'generate', attachment: block.attachment })
          }
          const settled = new Set(state.settled); settled.add(callId)
          return { ...state, settled, images: [...state.images, ...images] }
        },
        buildLocationData(context, scope, previous) {
          if (scope !== 'turn' || context.state === undefined) return null
          if (previous?.kind === 'turn' && previous.turn === context.state.turn && previous.key === KEY && previous.value.images === context.state.images) return previous
          return { kind: 'turn', turn: context.state.turn, key: KEY, value: { images: context.state.images } }
        },
      }
    }
    function selectedImages(owner) {
      const bound = owner.turn.end?.seq ?? owner.seq
      return (owner.turn.data.get(KEY)?.images ?? []).filter(item => item.seq <= bound)
    }
    function apply(ctx) {
      ctx.effect(() => ctx.uiConversation.events.register(createDefinition()), 'grok-imagine: replay generated images')
      function ImageTail(props) {
        const images = selectedImages(props)
        if (!images.length) return null
        return h('div', { 'data-grok-imagine-gallery': true, style: { display: 'flex', flexDirection: 'column', gap: 12, margin: '10px 0' } },
          ...images.map(item => h('div', { key: `${item.callId}:${item.attachment.attachmentId}`, 'data-grok-imagine-result': item.operation },
            props.renderFactorySlot('conversation.images.content', {
              images: [{ attachment: item.attachment, label: item.operation === 'edit' ? 'Grok 改图结果' : 'Grok 生成结果' }],
              loadImage: props.loadImage, align: 'start',
            }))))
      }
      ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
        name: 'conversation.chat.turnTail', id: KEY, order: -100,
        inject: sessionId => ({ loadImage: Object.assign(attachment => ctx.uiConversation.imageUrl(sessionId, attachment), { peek: attachment => ctx.uiConversation.peekImageUrl(sessionId, attachment) }) }),
      }, ImageTail))
    }
    return { apply, inject: ['slots', 'uiConversation'], createDefinition, selectedImages, imageRef }
  },
})
