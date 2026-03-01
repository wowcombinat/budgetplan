import { useEffect, useRef, useCallback } from 'react';
import { supabase } from './supabaseClient';

// Хук для синхронизации с Supabase
export function useSupabaseSync(userId, data, setData) {
  const initialized = useRef(false);
  const saveTimeout = useRef(null);
  const isLoading = useRef(false);

  // Загрузка данных при монтировании
  useEffect(() => {
    if (!userId || initialized.current) return;
    initialized.current = true;
    isLoading.current = true;

    const loadData = async () => {
      console.log('🔄 Загрузка данных для пользователя:', userId);

      try {
        // Загружаем все данные параллельно
        const [settingsRes, expensesRes, catsRes, transRes, goalsRes] = await Promise.all([
          supabase.from('budget_settings').select('*').eq('user_id', userId).maybeSingle(),
          supabase.from('base_expenses').select('*').eq('user_id', userId).order('sort_order'),
          supabase.from('categories').select('*').eq('user_id', userId).order('sort_order'),
          supabase.from('transactions').select('*').eq('user_id', userId).order('date', { ascending: false }),
          supabase.from('goals').select('*').eq('user_id', userId).order('created_at', { ascending: false })
        ]);

        const settings = settingsRes.data;
        const expenses = expensesRes.data;
        const cats = catsRes.data;
        const trans = transRes.data;
        const goalsData = goalsRes.data;

        // Проверяем есть ли данные в Supabase
        const hasSupabaseData = settings || (expenses && expenses.length > 0) || (cats && cats.length > 0);

        if (hasSupabaseData) {
          console.log('✅ Данные загружены из Supabase');

          let fetchedCurrentMonth = settings?.current_month;
          if (!fetchedCurrentMonth) {
            const now = new Date();
            fetchedCurrentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
          }

          setData({
            monthlyIncome: settings?.monthly_income?.toString() || '',
            currentMonth: fetchedCurrentMonth,
            baseExpenses: expenses && expenses.length > 0 ? expenses.map(e => ({
              id: e.id,
              name: e.name,
              amount: e.amount?.toString() || ''
            })) : [
              { id: 1, name: 'Аренда', amount: '' },
              { id: 2, name: 'Коммуналка', amount: '' },
              { id: 3, name: 'Страховки', amount: '' },
              { id: 4, name: 'Еда (базовая)', amount: '' },
            ],
            categories: cats && cats.length > 0 ? cats.map(c => ({
              id: c.id,
              name: c.name,
              percent: c.percent || 0,
              balance: c.balance || 0,
              carryOver: c.carry_over || false,
              isSavings: c.is_savings || false
            })) : [
              { id: 1, name: 'Новый бизнес', percent: 50, balance: 0, carryOver: true, isSavings: true },
              { id: 2, name: 'На черный день', percent: 10, balance: 0, carryOver: true, isSavings: true },
              { id: 3, name: 'Путешествия', percent: 20, balance: 0, carryOver: true, isSavings: false },
              { id: 4, name: 'Одежда', percent: 10, balance: 0, carryOver: false, isSavings: false },
              { id: 5, name: 'Развлечения', percent: 10, balance: 0, carryOver: false, isSavings: false },
            ],
            transactions: trans ? trans.map(t => ({
              id: t.id,
              type: t.type,
              date: t.date,
              month: t.month,
              categoryId: t.category_id,
              categoryName: t.category_name,
              amount: t.amount || 0,
              description: t.description,
              refundPending: t.refund_pending || false
            })) : [],
            // Цели из Supabase - связь по имени категории
            goals: goalsData ? goalsData.map(g => ({
              id: g.id,
              name: g.name,
              description: g.description,
              categoryName: g.category_name || '', // ВАЖНО: связь по имени
              targetAmount: g.target_amount || 0,
              targetDate: g.target_date,
              icon: g.icon || '🎯',
              createdAt: g.created_at,
              startBalance: g.start_balance || 0
            })) : []
          });
        } else {
          // Если в Supabase пусто - загружаем из localStorage
          console.log('📱 Supabase пуст, загружаем из localStorage');
          const storageKey = `budgetData_${userId}`;
          const saved = localStorage.getItem(storageKey);
          if (saved) {
            const parsed = JSON.parse(saved);
            setData(parsed);
          }
        }
      } catch (error) {
        console.error('❌ Ошибка загрузки из Supabase:', error);
        // Fallback на localStorage
        const storageKey = `budgetData_${userId}`;
        const saved = localStorage.getItem(storageKey);
        if (saved) {
          setData(JSON.parse(saved));
        }
      }

      isLoading.current = false;
    };

    loadData();
  }, [userId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Сохранение данных при изменении
  useEffect(() => {
    if (!userId || !initialized.current || isLoading.current) return;

    // Дебаунс
    if (saveTimeout.current) {
      clearTimeout(saveTimeout.current);
    }

    saveTimeout.current = setTimeout(async () => {
      console.log('💾 Сохранение данных...');

      // Сохраняем в localStorage как backup
      const storageKey = `budgetData_${userId}`;
      localStorage.setItem(storageKey, JSON.stringify(data));

      // Сохраняем в Supabase
      try {
        // 1. Настройки бюджета
        await supabase.from('budget_settings').upsert({
          user_id: userId,
          monthly_income: parseFloat(data.monthlyIncome) || 0,
          current_month: data.currentMonth,
          updated_at: new Date().toISOString()
        }, { onConflict: 'user_id' });

        // 2. Базовые расходы - удаляем старые и добавляем новые
        await supabase.from('base_expenses').delete().eq('user_id', userId);
        if (data.baseExpenses && data.baseExpenses.length > 0) {
          await supabase.from('base_expenses').insert(
            data.baseExpenses.map((exp, index) => ({
              user_id: userId,
              name: exp.name,
              amount: parseFloat(exp.amount) || 0,
              sort_order: index
            }))
          );
        }

        // 3. Категории - удаляем старые и добавляем новые
        await supabase.from('categories').delete().eq('user_id', userId);
        if (data.categories && data.categories.length > 0) {
          await supabase.from('categories').insert(
            data.categories.map((cat, index) => ({
              user_id: userId,
              name: cat.name,
              percent: cat.percent || 0,
              balance: cat.balance || 0,
              carry_over: cat.carryOver || false,
              is_savings: cat.isSavings || false,
              sort_order: index
            }))
          );
        }

        // 4. Цели - удаляем старые и добавляем новые (связь по имени категории!)
        await supabase.from('goals').delete().eq('user_id', userId);
        if (data.goals && data.goals.length > 0) {
          await supabase.from('goals').insert(
            data.goals.map(goal => ({
              user_id: userId,
              name: goal.name,
              description: goal.description || '',
              icon: goal.icon || '🎯',
              category_name: goal.categoryName, // ВАЖНО: связь по имени
              target_amount: goal.targetAmount || 0,
              target_date: goal.targetDate,
              start_balance: goal.startBalance || 0,
              created_at: goal.createdAt || new Date().toISOString()
            }))
          );
        }

        // 5. Транзакции - синхронизируем все (включая refund_pending)
        await supabase.from('transactions').delete().eq('user_id', userId);
        if (data.transactions && data.transactions.length > 0) {
          await supabase.from('transactions').insert(
            data.transactions.map(t => ({
              user_id: userId,
              type: t.type,
              date: t.date,
              month: t.month,
              category_id: t.categoryId,
              category_name: t.categoryName,
              amount: t.amount,
              description: t.description,
              refund_pending: t.refundPending || false
            }))
          );
        }

        console.log('✅ Данные сохранены в Supabase');
      } catch (error) {
        console.error('❌ Ошибка сохранения в Supabase:', error);
      }
    }, 1000);

    return () => {
      if (saveTimeout.current) {
        clearTimeout(saveTimeout.current);
      }
    };
  }, [userId, data]);

  // Добавление транзакции
  const addTransactionToSupabase = useCallback(async (transaction) => {
    const newTransaction = {
      id: Date.now(),
      ...transaction
    };

    // Добавляем в локальное состояние. Авто-сохранение (useEffect) само синхронизирует это с базой данных без дублей.
    setData(prev => ({
      ...prev,
      transactions: [newTransaction, ...prev.transactions]
    }));
  }, [userId, setData]);

  return { addTransactionToSupabase };
}
