/* =============================================================================
   Blackline Barbearia — script.js

   Organização:
     1. CONFIG      configurações por ambiente
     2. Utils       funções puras (DOM, datas, telefone)
     3. Api         comunicação REST (real + mock)
     4. Overlays    menu mobile e modais (baseados em :target)
     5. Navigation  links mortos e seção ativa
     6. WhatsApp    centraliza o número nos links wa.me
     7. Booking     formulário de agendamento
     8. App         inicialização

   O site funciona sem JavaScript. Este arquivo apenas melhora a experiência.
============================================================================= */

(() => {
    'use strict';


    /* =========================================================================
       1. CONFIG
    ========================================================================= */

    const CONFIG = {

        api: {
            baseUrl: '/api',
            timeoutMs: 10000,

            // true  = usa dados em memória (não precisa de backend)
            // false = usa a API REST real
            useMock: true,
        },

        whatsapp: {
            // TODO: trocar pelo número real: 55 + DDD + número, só dígitos.
            number: '5500000000000',
        },

        business: {
            openDays: [2, 3, 4, 5, 6],   // 0 = domingo ... 6 = sábado (terça a sábado)
            opensAt: '09:00',
            closesAt: '20:00',
            slotMinutes: 60,             // premissa: definir com o dono
            bookingWindowDays: 60,       // antecedência máxima
        },

        // Usado apenas pelo mock e como fallback visual. Em produção vem de GET /services.
        mockServices: [
            { id: 'corte', name: 'Corte Blackline', price: 55 },
            { id: 'corte-barba', name: 'Corte + Barba', price: 85 },
            { id: 'barba', name: 'Barba Premium', price: 40 },
        ],
    };

    const SEL = {
        overlay: '.modal, .mobile-nav',
        closers: '.modal__close, .modal__backdrop, .mobile-nav__overlay, .mobile-nav__close',
        menuButton: '.menu-button',
        form: '[data-booking-form]',
    };


    /* =========================================================================
       2. UTILS
    ========================================================================= */

    const $ = (selector, scope = document) => scope.querySelector(selector);
    const $$ = (selector, scope = document) => Array.from(scope.querySelectorAll(selector));

    const digits = (value) => String(value || '').replace(/\D/g, '');

    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    const Dates = {

        pad: (n) => String(n).padStart(2, '0'),

        today() {
            const d = new Date();
            d.setHours(0, 0, 0, 0);
            return d;
        },

        addDays(date, days) {
            const d = new Date(date);
            d.setDate(d.getDate() + days);
            return d;
        },

        /** Date -> "YYYY-MM-DD" (data local, sem problemas de fuso) */
        toISO(date) {
            return `${date.getFullYear()}-${Dates.pad(date.getMonth() + 1)}-${Dates.pad(date.getDate())}`;
        },

        /** "YYYY-MM-DD" -> Date (ou null se inválida) */
        fromISO(iso) {
            const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
            if (!m) return null;

            const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
            return date.getMonth() === Number(m[2]) - 1 ? date : null;
        },

        /** "YYYY-MM-DD" -> "DD/MM/YYYY" */
        format(iso) {
            const [y, m, d] = iso.split('-');
            return `${d}/${m}/${y}`;
        },

        toMinutes(time) {
            const [h, m] = time.split(':').map(Number);
            return h * 60 + m;
        },

        fromMinutes(total) {
            return `${Dates.pad(Math.floor(total / 60))}:${Dates.pad(total % 60)}`;
        },
    };

    const Phone = {

        /** Remove o 55 inicial e devolve só DDD + número */
        normalize(value) {
            let d = digits(value);
            if ((d.length === 12 || d.length === 13) && d.startsWith('55')) d = d.slice(2);
            return d;
        },

        isValid(value) {
            const d = Phone.normalize(value);

            if (d.length !== 10 && d.length !== 11) return false;
            if (!/^[1-9][1-9]/.test(d)) return false;          // DDD válido
            if (d.length === 11 && d[2] !== '9') return false; // celular começa com 9

            return true;
        },

        /** Máscara: (00) 90000-0000 */
        mask(value) {
            const d = digits(value).slice(0, 11);

            if (d.length <= 2) return d ? `(${d}` : '';
            if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
            if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;

            return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
        },
    };


    /* =========================================================================
       3. API
       Único ponto do código que conhece fetch.
       Contrato esperado do backend:
         GET  /services                          -> { services: [{ id, name, price }] }
         GET  /availability?date=&serviceId=     -> { date, slots: ["09:00", ...] }
         POST /appointments                      -> 201 { appointment: {...} }
       Erros: 409 { code: "SLOT_TAKEN" } | 422 { errors: { campo: "msg" } }
    ========================================================================= */

    class ApiError extends Error {
        constructor(message, { status = 0, code = '', fields = null } = {}) {
            super(message);
            this.name = 'ApiError';
            this.status = status;
            this.code = code;
            this.fields = fields;
        }
    }

    const realApi = (() => {

        async function request(path, { method = 'GET', body, query } = {}) {
            const base = CONFIG.api.baseUrl.replace(/\/$/, '');
            const url = new URL(base + path, window.location.origin);

            if (query) {
                Object.entries(query).forEach(([key, value]) => {
                    if (value !== undefined && value !== null && value !== '') {
                        url.searchParams.set(key, value);
                    }
                });
            }

            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), CONFIG.api.timeoutMs);

            try {
                const response = await fetch(url, {
                    method,
                    headers: {
                        Accept: 'application/json',
                        ...(body ? { 'Content-Type': 'application/json' } : {}),
                    },
                    body: body ? JSON.stringify(body) : undefined,
                    signal: controller.signal,
                });

                const data = await response.json().catch(() => null);

                if (!response.ok) {
                    throw new ApiError(data?.message || 'Erro na requisição.', {
                        status: response.status,
                        code: data?.code || '',
                        fields: data?.errors || null,
                    });
                }

                return data;

            } catch (error) {
                if (error instanceof ApiError) throw error;
                if (error.name === 'AbortError') throw new ApiError('Tempo esgotado.', { code: 'TIMEOUT' });
                throw new ApiError('Falha de rede.', { code: 'NETWORK' });

            } finally {
                clearTimeout(timer);
            }
        }

        return {
            getServices: () => request('/services'),
            getAvailability: ({ date, serviceId }) => request('/availability', { query: { date, serviceId } }),
            createAppointment: (payload) => request('/appointments', { method: 'POST', body: payload }),
        };
    })();


    /** Simula o backend em memória, para desenvolver o frontend sem API. */
    const mockApi = (() => {

        const booked = new Set();

        return {

            async getServices() {
                await delay(250);
                return { services: CONFIG.mockServices };
            },

            async getAvailability({ date }) {
                await delay(350);

                const day = Dates.fromISO(date);
                const { openDays, opensAt, closesAt, slotMinutes } = CONFIG.business;

                if (!day || !openDays.includes(day.getDay())) return { date, slots: [] };

                const now = new Date();
                const isToday = Dates.toISO(now) === date;
                const nowMinutes = now.getHours() * 60 + now.getMinutes();

                const slots = [];

                for (let t = Dates.toMinutes(opensAt); t + slotMinutes <= Dates.toMinutes(closesAt); t += slotMinutes) {
                    const time = Dates.fromMinutes(t);

                    if (isToday && t <= nowMinutes) continue;
                    if (booked.has(`${date}|${time}`)) continue;

                    slots.push(time);
                }

                return { date, slots };
            },

            async createAppointment(payload) {
                await delay(600);

                const key = `${payload.date}|${payload.time}`;

                if (booked.has(key)) {
                    throw new ApiError('Horário indisponível.', { status: 409, code: 'SLOT_TAKEN' });
                }

                booked.add(key);

                return { appointment: { id: `mock-${Date.now()}`, ...payload, status: 'pending' } };
            },
        };
    })();

    const Api = CONFIG.api.useMock ? mockApi : realApi;


    /* =========================================================================
       4. OVERLAYS — menu mobile e modais (:target)
       O CSS abre/fecha por :target. Aqui adicionamos:
         - fechar com Esc
         - fechar sem pular a página para o topo (restaura o scroll)
         - foco ao abrir, foco preso dentro, foco devolvido ao fechar
         - aria-expanded no botão do menu
    ========================================================================= */

    const Overlays = (() => {

        const FOCUSABLE = [
            'a[href]',
            'button:not([disabled])',
            'input:not([disabled])',
            'select:not([disabled])',
            'textarea:not([disabled])',
            '[tabindex]:not([tabindex="-1"])',
        ].join(',');

        let current = null;       // overlay aberto
        let savedScroll = null;   // posição da página antes de abrir
        let lastTrigger = null;   // elemento que abriu o overlay

        const getHashTarget = (hash) => {
            try {
                const id = decodeURIComponent(String(hash || '').replace(/^#/, ''));
                return id ? document.getElementById(id) : null;
            } catch {
                return null;
            }
        };

        const isOpenOverlay = (el) =>
            Boolean(el) && el.matches(SEL.overlay) && el.getClientRects().length > 0;

        const updateMenuButton = () => {
            const button = $(SEL.menuButton);
            if (button) button.setAttribute('aria-expanded', String(current?.id === 'menu-mobile'));
        };

        /** Sincroniza o estado do JS com o hash atual da URL */
        const sync = () => {
            const target = getHashTarget(window.location.hash);
            const next = isOpenOverlay(target) ? target : null;

            if (next === current) return;

            current = next;
            updateMenuButton();

            if (current) {
                const first = $('.modal__close, .mobile-nav__close', current) || current;
                requestAnimationFrame(() => first.focus({ preventScroll: true }));
            } else {
                savedScroll = null;
            }
        };

        const close = () => {
            if (!current) return;

            const scrollY = savedScroll;
            const trigger = lastTrigger;

            // Hash vazio remove o :target. O navegador tenta rolar ao topo,
            // então restauramos a posição logo em seguida (mesmo ciclo, sem piscar).
            window.location.hash = '';

            if (scrollY !== null) {
                window.scrollTo({ top: scrollY, left: 0, behavior: 'instant' });
            }

            if (trigger && document.contains(trigger)) {
                trigger.focus({ preventScroll: true });
            }

            lastTrigger = null;
        };

        const trapFocus = (event) => {
            const items = $$(FOCUSABLE, current).filter((el) => el.getClientRects().length > 0);
            if (!items.length) return;

            const first = items[0];
            const last = items[items.length - 1];

            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            } else if (!current.contains(document.activeElement)) {
                event.preventDefault();
                first.focus();
            }
        };

        const onClick = (event) => {
            const link = event.target.closest('a[href^="#"]');
            if (!link) return;

            // Botões de fechar
            if (link.matches(SEL.closers)) {
                if (current) {
                    event.preventDefault();
                    close();
                }
                return;
            }

            // Links que abrem um overlay: guarda scroll e gatilho
            const target = getHashTarget(link.hash);

            if (target && target.matches(SEL.overlay) && !current) {
                savedScroll = window.scrollY;
                lastTrigger = link;
            }
        };

        const onKeydown = (event) => {
            if (!current) return;

            if (event.key === 'Escape') {
                event.preventDefault();
                close();
            } else if (event.key === 'Tab') {
                trapFocus(event);
            }
        };

        const init = () => {
            document.addEventListener('click', onClick);
            document.addEventListener('keydown', onKeydown);
            window.addEventListener('hashchange', sync);
            window.addEventListener('resize', sync);   // menu mobile some em telas largas

            sync();
        };

        return { init, close, isOpen: () => Boolean(current) };
    })();


    /* =========================================================================
       5. NAVIGATION
    ========================================================================= */

    const Navigation = (() => {

        /** href="#" (Instagram, Privacidade, Termos) não deve rolar ao topo */
        const blockDeadLinks = () => {
            document.addEventListener('click', (event) => {
                const link = event.target.closest('a[href="#"]');
                if (link) event.preventDefault();
            });
        };

        /** Marca o link da seção visível com aria-current (acessibilidade) */
        const trackActiveSection = () => {
            if (!('IntersectionObserver' in window)) return;

            const links = $$('.header__nav a[href^="#"]');
            const map = new Map();

            links.forEach((link) => {
                const section = $(link.getAttribute('href'));
                if (section) map.set(section, link);
            });

            if (!map.size) return;

            const observer = new IntersectionObserver((entries) => {
                entries.forEach((entry) => {
                    if (!entry.isIntersecting) return;

                    links.forEach((link) => link.removeAttribute('aria-current'));
                    map.get(entry.target)?.setAttribute('aria-current', 'location');
                });
            }, { rootMargin: '-45% 0px -50% 0px', threshold: 0 });

            map.forEach((_, section) => observer.observe(section));
        };

        const init = () => {
            blockDeadLinks();
            trackActiveSection();
        };

        return { init };
    })();


    /* =========================================================================
       6. WHATSAPP
       Troque o número em CONFIG.whatsapp.number e todos os links são atualizados.
    ========================================================================= */

    const WhatsApp = (() => {

        const number = () => digits(CONFIG.whatsapp.number);

        /** Monta um link wa.me com mensagem pronta */
        const buildLink = (message) =>
            `https://wa.me/${number()}?text=${encodeURIComponent(message)}`;

        const init = () => {
            if (!number()) return;

            $$('a[href^="https://wa.me/"]').forEach((link) => {
                const url = new URL(link.href);
                url.pathname = `/${number()}`;
                link.href = url.toString();
            });
        };

        return { init, buildLink };
    })();


    /* =========================================================================
       7. BOOKING — formulário de agendamento
       Só é ativado se existir <form data-booking-form> no HTML.
       Campos esperados (atributo name): service, date, time, name, phone.
    ========================================================================= */

    const Booking = (() => {

        const FIELDS = ['service', 'date', 'time', 'name', 'phone'];

        let form = null;
        let fields = {};
        let statusEl = null;
        let submitBtn = null;
        let submitLabel = '';
        let busy = false;
        let slotsRequestId = 0;
        const touched = new Set();


        /* ---------- Validação ---------- */

        const validators = {

            service: (v) => (v ? '' : 'Escolha um serviço.'),

            date(v) {
                if (!v) return 'Escolha uma data.';

                const date = Dates.fromISO(v);
                if (!date) return 'Data inválida.';

                const today = Dates.today();
                const max = Dates.addDays(today, CONFIG.business.bookingWindowDays);

                if (date < today) return 'Escolha uma data a partir de hoje.';
                if (date > max) return `Agendamos com até ${CONFIG.business.bookingWindowDays} dias de antecedência.`;
                if (!CONFIG.business.openDays.includes(date.getDay())) return 'Atendemos de terça a sábado.';

                return '';
            },

            time: (v) => (v ? '' : 'Escolha um horário.'),

            name(v) {
                const name = v.trim();

                if (name.length < 2) return 'Informe seu nome.';
                if (name.length > 80) return 'Nome muito longo.';
                if (!/^\p{L}[\p{L}\s'.-]*$/u.test(name)) return 'Use apenas letras no nome.';

                return '';
            },

            phone: (v) => (Phone.isValid(v) ? '' : 'Informe um WhatsApp válido, com DDD.'),
        };

        const getValues = () => ({
            service: fields.service?.value || '',
            date: fields.date?.value || '',
            time: fields.time?.value || '',
            name: (fields.name?.value || '').trim(),
            phone: fields.phone?.value || '',
        });


        /* ---------- Mensagens de erro por campo ---------- */

        const setFieldError = (name, message) => {
            const field = fields[name];
            if (!field) return;

            const holder = field.closest('.form-group') || field.parentElement;
            let el = $(`[data-error-for="${name}"]`, holder);

            if (!message) {
                el?.remove();
                field.removeAttribute('aria-invalid');
                field.removeAttribute('aria-describedby');
                return;
            }

            if (!el) {
                el = document.createElement('p');
                el.className = 'form-error';
                el.id = `booking-${name}-error`;
                el.dataset.errorFor = name;
                holder.append(el);
            }

            el.textContent = message;
            field.setAttribute('aria-invalid', 'true');
            field.setAttribute('aria-describedby', el.id);
        };

        const validateField = (name) => {
            const message = validators[name]?.(getValues()[name]) || '';
            setFieldError(name, message);
            return !message;
        };

        const validateAll = () => {
            let firstInvalid = null;

            FIELDS.forEach((name) => {
                if (!fields[name]) return;

                touched.add(name);

                if (!validateField(name) && !firstInvalid) firstInvalid = fields[name];
            });

            firstInvalid?.focus();
            return !firstInvalid;
        };


        /* ---------- Mensagem geral (sucesso / erro / carregando) ---------- */

        const setStatus = (state, message = '', link = null) => {
            statusEl.dataset.state = state;
            statusEl.hidden = !state;
            statusEl.textContent = message;
            statusEl.setAttribute('role', state === 'error' ? 'alert' : 'status');

            if (link) {
                const anchor = document.createElement('a');
                anchor.href = link.href;
                anchor.textContent = link.label;
                anchor.className = 'button button--primary';
                anchor.target = '_blank';
                anchor.rel = 'noopener noreferrer';
                statusEl.append(document.createElement('br'), anchor);
            }
        };

        const friendlyError = (error) => {
            if (error?.code === 'SLOT_TAKEN') return 'Esse horário acabou de ser ocupado. Escolha outro.';
            if (error?.code === 'TIMEOUT') return 'O servidor demorou para responder. Tente novamente.';
            if (error?.code === 'NETWORK') return 'Sem conexão. Verifique sua internet e tente novamente.';
            if (error?.status === 422) return 'Confira os campos destacados.';
            if (error?.status >= 500) return 'Erro no servidor. Tente novamente em instantes.';

            return 'Não foi possível concluir. Tente novamente ou fale pelo WhatsApp.';
        };

        const setBusy = (value) => {
            busy = value;

            if (!submitBtn) return;

            submitBtn.disabled = value;
            submitBtn.setAttribute('aria-busy', String(value));
            submitBtn.textContent = value ? 'Enviando…' : submitLabel;
        };


        /* ---------- Horários disponíveis ---------- */

        const renderSlots = (slots, placeholder = 'Selecione') => {
            const select = fields.time;
            if (!select || select.tagName !== 'SELECT') return;

            const previous = select.value;
            select.replaceChildren();

            const first = document.createElement('option');
            first.value = '';
            first.textContent = placeholder;
            select.append(first);

            (slots || []).forEach((time) => {
                const option = document.createElement('option');
                option.value = time;
                option.textContent = time;
                select.append(option);
            });

            if (slots?.includes(previous)) select.value = previous;

            select.disabled = !slots?.length;
        };

        const loadSlots = async () => {
            if (!fields.time) return;

            const { service, date } = getValues();
            const requestId = ++slotsRequestId;

            setFieldError('time', '');

            if (!service || validators.date(date)) {
                renderSlots([], 'Escolha serviço e data');
                return;
            }

            renderSlots([], 'Carregando horários…');

            try {
                const { slots } = await Api.getAvailability({ date, serviceId: service });

                if (requestId !== slotsRequestId) return;   // resposta antiga: ignora

                if (!slots.length) {
                    renderSlots([], 'Sem horários');
                    setFieldError('time', 'Sem horários livres nesta data. Tente outro dia.');
                    return;
                }

                renderSlots(slots);

            } catch (error) {
                if (requestId !== slotsRequestId) return;

                renderSlots([], 'Indisponível');
                setStatus('error', friendlyError(error));
            }
        };

        /** Preenche o select de serviços pela API (se o HTML só tiver o placeholder) */
        const loadServices = async () => {
            const select = fields.service;
            if (!select || select.tagName !== 'SELECT' || select.options.length > 1) return;

            try {
                const { services } = await Api.getServices();

                services.forEach((service) => {
                    const option = document.createElement('option');
                    option.value = service.id;
                    option.textContent = service.price
                        ? `${service.name} — R$ ${service.price}`
                        : service.name;
                    select.append(option);
                });

            } catch {
                // Silencioso: o usuário ainda pode usar o botão do WhatsApp.
            }
        };


        /* ---------- Envio ---------- */

        const buildWhatsAppConfirmation = (values) => {
            const serviceName = fields.service?.selectedOptions[0]?.textContent.split(' — ')[0] || values.service;

            return WhatsApp.buildLink(
                `Olá! Agendei pelo site da Blackline: ${serviceName}, ` +
                `${Dates.format(values.date)} às ${values.time}. Nome: ${values.name}.`
            );
        };

        const onSubmit = async (event) => {
            event.preventDefault();

            if (busy) return;

            setStatus('');

            if (!validateAll()) return;

            const values = getValues();

            const payload = {
                serviceId: values.service,
                date: values.date,
                time: values.time,
                name: values.name,
                phone: Phone.normalize(values.phone),
            };

            setBusy(true);

            try {
                await Api.createAppointment(payload);

                form.reset();
                touched.clear();
                FIELDS.forEach((name) => setFieldError(name, ''));
                renderSlots([], 'Escolha serviço e data');

                setStatus(
                    'success',
                    `Agendamento solicitado para ${Dates.format(values.date)} às ${values.time}. Você pode confirmar pelo WhatsApp:`,
                    { href: buildWhatsAppConfirmation(values), label: 'Confirmar pelo WhatsApp' }
                );

                statusEl.focus();

            } catch (error) {
                setStatus('error', friendlyError(error));

                if (error.fields) {
                    Object.entries(error.fields).forEach(([name, message]) => setFieldError(name, message));
                }

                if (error.code === 'SLOT_TAKEN') {
                    setFieldError('time', 'Horário indisponível.');
                    loadSlots();
                }

                statusEl.focus();

            } finally {
                setBusy(false);
            }
        };


        /* ---------- Inicialização ---------- */

        const bindEvents = () => {
            form.addEventListener('submit', onSubmit);

            // Valida ao sair do campo; depois, revalida enquanto digita
            form.addEventListener('focusout', (event) => {
                const name = event.target.name;
                if (!FIELDS.includes(name)) return;

                touched.add(name);
                validateField(name);
            });

            form.addEventListener('input', (event) => {
                const name = event.target.name;
                if (!FIELDS.includes(name)) return;

                if (name === 'phone') event.target.value = Phone.mask(event.target.value);

                if (touched.has(name)) validateField(name);
            });

            fields.service?.addEventListener('change', loadSlots);
            fields.date?.addEventListener('change', loadSlots);
        };

        const init = () => {
            form = $(SEL.form);
            if (!form) return;

            FIELDS.forEach((name) => {
                fields[name] = $(`[name="${name}"]`, form);
            });

            submitBtn = $('[type="submit"]', form);
            submitLabel = submitBtn?.textContent.trim() || 'Confirmar agendamento';

            // Região de mensagens gerais
            statusEl = document.createElement('div');
            statusEl.className = 'form-status';
            statusEl.dataset.formStatus = '';
            statusEl.tabIndex = -1;
            statusEl.hidden = true;

            if (submitBtn) submitBtn.before(statusEl);
            else form.append(statusEl);

            // Limites do campo de data
            if (fields.date?.type === 'date') {
                const today = Dates.today();
                fields.date.min = Dates.toISO(today);
                fields.date.max = Dates.toISO(Dates.addDays(today, CONFIG.business.bookingWindowDays));
            }

            if (fields.phone) {
                fields.phone.setAttribute('inputmode', 'tel');
                fields.phone.setAttribute('maxlength', '15');
            }

            renderSlots([], 'Escolha serviço e data');
            bindEvents();
            loadServices();
        };

        return { init };
    })();


    /* =========================================================================
       8. APP
    ========================================================================= */

    const App = {

        init() {
            Overlays.init();
            Navigation.init();
            WhatsApp.init();
            Booking.init();
        },
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', App.init);
    } else {
        App.init();
    }

})();